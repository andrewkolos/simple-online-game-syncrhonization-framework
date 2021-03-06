import { TimestampedBuffer, Timestamped } from './timestamped-buffer';

export interface LcRequest {
  timestamp: number;
}

export interface ResimulationContext<State> {
  /** The state before the current state to be recomputed, as it was before the request. */
  oldPreviousState: Timestamped<State>;
  /** The state before the current state to be recomputed, newly computed after the request. */
  newPreviousState: Timestamped<State>;
  /** The current state, to be resimulated. */
  oldCurrentState: Timestamped<State>;
}

export type Resimulator<G> = (context: ResimulationContext<G>) => G;

export type RequestApplicator<Request, State> = (state: State, request: Request) => State;

export interface LagCompensationRequestValidationContext<State> {
  serverHistory: TimestampedBuffer<State>;
  clientLatency: number;
}

export type LagCompensationRequestValidator<Request, State> = (request: Request, context: LagCompensationRequestValidationContext<State>) => boolean;

export interface LagCompensatorCalculatorArgs<State, ClientRequest extends LcRequest> {
  resimmer: Resimulator<State>;
  requestApplicator: RequestApplicator<ClientRequest, State>;
  requestValidator: LagCompensationRequestValidator<ClientRequest, State>;
}

export interface LagCompensationRequestContext<GameState> {
  serverHistory: TimestampedBuffer<GameState>;
  clientLatency: number;
}

/**
 * The `LagCompensator` is responsible for
 * validating lag compensation requests sent by clients, applying them, and resimulating
 * the state of the game when requests are accepted.
 */
export class LagCompensator<GameState, ClientRequest extends LcRequest> {

  private readonly resimmer: Resimulator<GameState>;
  private readonly requestApplicator: RequestApplicator<ClientRequest, GameState>;
  private readonly requestValidator: LagCompensationRequestValidator<ClientRequest, GameState>;

  public constructor(args: LagCompensatorCalculatorArgs<GameState, ClientRequest>) {
    this.resimmer = args.resimmer;
    this.requestApplicator = args.requestApplicator;
    this.requestValidator = args.requestValidator;
  }

  /**
   * Process a lag compensation request sent by a client.
   * @param serverHistory The history of the state of the game. Used to determine the state of the game at the time of request
   * and to resimulate the game to the present if the request is accepted.
   * @param request The request sent by the client.
   * @returns Whether or not the request was accepted.
   */
  public processRequest(request: ClientRequest, context: LagCompensationRequestContext<GameState>): boolean {

    const {serverHistory} = context;

    const stateHistory = Array.from(serverHistory.slice(request.timestamp));

    if (stateHistory.length === 0) {
      return false;
    }

    const gameStateAtRequestedTime = stateHistory[0];

    if (!this.requestValidator(request, context)) return false;

    const stateAfterCompensation = this.requestApplicator(gameStateAtRequestedTime.value, request);

    const resimulatedStates = this.resimulate(stateHistory, stateAfterCompensation);
    resimulatedStates.forEach((state: Timestamped<GameState>) => serverHistory.rewrite(state.timestamp, state.value));

    return true;
  }

  private resimulate(history: Array<Timestamped<GameState>>, firstStateAfterCompensation: GameState): Array<Timestamped<GameState>> {
    const newHistory: Array<Timestamped<GameState>> = [{ timestamp: history[0].timestamp, value: firstStateAfterCompensation }];
    if (history.length === 1) return newHistory;

    for (let i = 1; i < history.length; i++) {
      const newState = this.resimmer({
        oldPreviousState: history[i - 1],
        newPreviousState: newHistory[i - 1],
        oldCurrentState: history[i],
      });
      newHistory.push({ timestamp: history[i].timestamp, value: newState });
    }

    return newHistory;
  }
}
