import { add, multiply, Circle } from './math';

/** Runs a small calculation pipeline. */
export function calculate(x: number, y: number): number {
  const sum = add(x, y);
  const product = multiply(sum, y);
  const circle = new Circle(product);
  return circle.area();
}

/** Entry point used by the CLI. */
export function report(x: number): number {
  return calculate(x, x);
}
