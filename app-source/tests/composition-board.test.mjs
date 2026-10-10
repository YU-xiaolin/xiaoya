import assert from "node:assert/strict";
import test from "node:test";
import {
  compositionInstructions,
  createCompositionBoard,
  isCompositionModel,
  moveCompositionBoard
} from "../src/composition-board.js";

test("五个苹果先分两边、合回总数，最后才进入作答", () => {
  const task = { subject: "math", evidenceType: "math_visual_model", composition: { whole: 5, left: 2 } };
  assert.equal(isCompositionModel(task), true);
  let board = createCompositionBoard(task);
  assert.equal(board.phase, "left");
  assert.equal(moveCompositionBoard(board, "right"), board);
  board = moveCompositionBoard(board, "left");
  assert.deepEqual([board.left, board.right, board.phase], [1, 0, "left"]);
  board = moveCompositionBoard(board, "left");
  assert.equal(board.phase, "right");
  assert.equal(moveCompositionBoard(board, "left"), board);
  for (let count = 0; count < 3; count += 1) board = moveCompositionBoard(board, "right");
  assert.deepEqual([board.left, board.right, board.phase], [2, 3, "join"]);
  board = moveCompositionBoard(board, "join");
  assert.equal(board.phase, "answer");
  assert.equal(board.left + board.right, board.whole);
  assert.doesNotMatch(compositionInstructions(task.composition).answer, /3/u);
  board = moveCompositionBoard(board, "restart");
  assert.deepEqual([board.left, board.right, board.phase], [0, 0, "left"]);
});
