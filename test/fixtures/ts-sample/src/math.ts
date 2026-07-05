import { logger } from './logger';
import type { Config } from './config';

/** Adds two numbers. */
export function add(a: number, b: number): number {
  return a + b;
}

// Multiplies two numbers.
// Used by the calculator.
export const multiply = (a: number, b: number): number => a * b;

const INTERNAL_FACTOR = 2;

export interface Shape {
  area(): number;
  readonly name: string;
}

export class Circle implements Shape {
  readonly name = 'circle';

  constructor(private radius: number) {}

  /** Area of the circle. */
  area(): number {
    return Math.PI * this.radius ** 2 * INTERNAL_FACTOR;
  }
}

export enum Color {
  Red,
  Green = 'green',
}

export type Point = { x: number; y: number };

export namespace Geometry {
  export function distance(a: Point, b: Point): number {
    logger.debug('distance');
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
}
