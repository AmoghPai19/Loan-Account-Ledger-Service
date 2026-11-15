import assert from 'node:assert/strict';

/** Checks only the listed fields of an object, e.g. assertFields(row, { interestDuePaise: 150000 }). */
export function assertFields(actual, expected, message) {
  const picked = Object.fromEntries(Object.keys(expected).map((k) => [k, actual[k]]));
  assert.deepEqual(picked, expected, message);
}