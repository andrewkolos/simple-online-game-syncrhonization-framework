import { Interval } from 'interval-task-runner';
import { Entity, Interpolator } from '../../entity';
import { interpolateStatesLinearly, NumericObject } from '../../interpolate-linearly';
import { DefaultMap } from '../../util/default-map';

type EntityId = string;

type StateBuffer<State> = Array<{
  state: State;
  receivedAt: number;
}>;

export class MultiEntityStateInterpolator<State> {

  public static withBasicInterpolationStrategy<State extends NumericObject>(serverUpdateRateHz: number)
    : MultiEntityStateInterpolator<State> {
    return new MultiEntityStateInterpolator(serverUpdateRateHz, interpolateStatesLinearly);
  }

  public static withCustomInterpolationStrategy<State>(serverUpdateRateHz: number,
    strategy: Interpolator<State>): MultiEntityStateInterpolator<State> {
    return new MultiEntityStateInterpolator(serverUpdateRateHz, strategy);
  }

  private readonly serverUpdateRateHz: number;
  private interpolationStrategy: Interpolator<State>;

  private readonly singleInterpolators: DefaultMap<EntityId, SingleEntityStateInterpolator<State>> =
    new DefaultMap(() => SingleEntityStateInterpolator
      .withCustomInterpolationStrategy(this.serverUpdateRateHz, this.interpolationStrategy));

  private constructor(serverUpdateRateHz: number, interpolationStrategy: Interpolator<State>) {
    this.serverUpdateRateHz = serverUpdateRateHz;
    this.interpolationStrategy = interpolationStrategy;
  }

  public setInterpolationStrategy(strategy: Interpolator<State>) {
    this.interpolationStrategy = strategy;
  }

  public interpolate(newStatesFromServer: Array<Entity<State>>): Array<Entity<State>> {
    const statesByEntityId = newStatesFromServer.reduce((acc: DefaultMap<EntityId, State[]>, ebs) => {
      acc.get(ebs.id).push(ebs.state);
      return acc;
    }, new DefaultMap<EntityId, State[]>(() => []));

    const interpolatedStates: Array<Entity<State>> = [];

    // Create interpolators for new entities.
    for (const [id, _] of statesByEntityId) {
      if (!this.singleInterpolators.has(id)) {
        this.singleInterpolators.set(id, SingleEntityStateInterpolator.withCustomInterpolationStrategy(this.serverUpdateRateHz, this.interpolationStrategy));
      }
    }

    for (const [id, interpolator] of this.singleInterpolators) {
      const newStatesForEntity = statesByEntityId.get(id);
      interpolatedStates.push({ id, state: interpolator.interpolate(...newStatesForEntity) });
    }

    return interpolatedStates;
  }
}

class SingleEntityStateInterpolator<State> {

  public static withBasicInterpolationStrategy<State extends NumericObject>(serverUpdateRateHz: number)
    : SingleEntityStateInterpolator<State> {
    return new SingleEntityStateInterpolator(serverUpdateRateHz, interpolateStatesLinearly);
  }

  public static withCustomInterpolationStrategy<State>(serverUpdateRateHz: number,
    strategy: Interpolator<State>): SingleEntityStateInterpolator<State> {
    return new SingleEntityStateInterpolator(serverUpdateRateHz, strategy);
  }

  private readonly stateBuffer: StateBuffer<State> = [];

  private readonly serverUpdateRateHz: number;
  private readonly interpolationStrategy: Interpolator<State>;

  private constructor(serverUpdateRateHz: number, interpolationStrategy: Interpolator<State>) {
    this.serverUpdateRateHz = serverUpdateRateHz;
    this.interpolationStrategy = interpolationStrategy;
  }

  public interpolate(...newStatesFromServer: State[]): State {

    this.pushNewStatesOntoBuffer(newStatesFromServer);
    this.dropUnneededOldStatesFromBuffer();

    const buffer = this.stateBuffer;
    const renderTimestamp = new Date().getTime() - Interval.fromHz(this.serverUpdateRateHz).ms;

    if (buffer.length >= 2 && buffer[0].receivedAt <= renderTimestamp && renderTimestamp) {
      const timeRatio = (renderTimestamp - buffer[0].receivedAt) / (buffer[1].receivedAt - buffer[0].receivedAt);
      return this.interpolationStrategy(buffer[0].state, buffer[1].state, timeRatio);
    } else if (buffer.length === 0) {
      throw Error('Cannot compute interpolated state when interpolator has yet to be given any states.');
    } else {
      return buffer[0].state;
    }
  }

  private pushNewStatesOntoBuffer(newStatesFromServer: State[]) {
    const now = new Date().getTime();
    const timestamped = newStatesFromServer.map((state: State) => ({ state, receivedAt: now }));
    this.stateBuffer.push(...timestamped);
  }

  private dropUnneededOldStatesFromBuffer() {
    const buffer = this.stateBuffer;
    const now = new Date().getTime();
    const renderTimestamp = now - Interval.fromHz(this.serverUpdateRateHz).ms;
    while (buffer.length >= 2 && this.stateBuffer[1].receivedAt <= renderTimestamp) {
      buffer.shift();
    }
  }
}
