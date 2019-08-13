/**
 * Given two states and a time ratio (0 => state1, 0.5 => halfway between, 1.0 => state2), computes
 * a simple interpolation.
 * @param state1 The first state to interpolate from.
 * @param state2 The second state to interpolate towards.
 * @param timeRatio How far the computed state should be from state1 to state2.
 */
export function interpolateStatesLinearly<T extends any>(state1: T, state2: T, timeRatio: number): T {
  const newState: any = {};

  Object.keys(state1).forEach((key: string) => {
    if (typeof state1[key] === "number") {
      newState[key] = interpolateLinearly(state1[key], state2[key], timeRatio);
    } else if (typeof state1[key] === "object") {
      newState[key] = interpolateStatesLinearly(state1[key], state2[key], timeRatio);
    } else {
      throw Error(`Cannot interpolate non-number / non-number object property '${key}'.`);
    }
  });

  return newState;
}

export function interpolateLinearly(state1: number, state2: number, timeRatio: number) {
  return state1 + (state2 - state1) * timeRatio;
}

export class LinearInterpolator<T> {

  public static from<T>(currentState: T) {
    return new LinearInterpolator(currentState);
  }
  private constructor(private from: T) { }

  public to(newState: T) {
    return new CompleteLinearInterpolator(this.from, newState);
  }

}

class CompleteLinearInterpolator<T> {
  public constructor(private from: T, private to: T) { }

  public interpolate(timeRatio: number) {
    return interpolateStatesLinearly(this.from, this.to, timeRatio);
  }
}
