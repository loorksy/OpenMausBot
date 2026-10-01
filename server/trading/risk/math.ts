/** Fixed-point lots and USD amounts. 1e-8 is the calculation quantum.
 * Integer division floors, so a derived quantity cannot round above a budget. */

const SCALE = 100_000_000n;

export function scale(value: number): bigint {
  if (!Number.isFinite(value)) {
    throw new Error("non-finite");
  }
  return BigInt(Math.round(value * 100_000_000));
}

export function unscale(value: bigint): number {
  const sign = value < 0n ? -1 : 1;
  const abs = value < 0n ? -value : value;
  const whole = abs / SCALE;
  const frac = abs % SCALE;
  return sign * Number(`${whole.toString()}.${frac.toString().padStart(8, "0")}`);
}

export function mul(left: bigint, right: bigint): bigint {
  return (left * right) / SCALE;
}

export function floorToStep(quantity: bigint, step: bigint): bigint {
  if (step <= 0n) return 0n;
  return (quantity / step) * step;
}

export function onStep(quantity: bigint, step: bigint): boolean {
  return step > 0n && quantity % step === 0n;
}
