export function isCompositionModel(task) {
  const whole = Number(task?.composition?.whole);
  const left = Number(task?.composition?.left);
  return task?.subject === "math" && task?.evidenceType === "math_visual_model"
    && Number.isInteger(whole) && whole >= 2 && whole <= 5
    && Number.isInteger(left) && left > 0 && left < whole;
}

export function compositionInstructions(composition) {
  const { whole, left } = composition;
  return {
    left: `这里有 ${whole} 个苹果。先给左边的盘子放 ${left} 个。`,
    right: "把剩下的苹果一个一个放进右边的盘子。",
    join: "看一看两边的苹果。点合起来，看看总数有没有变。",
    answer: `合起来还是 ${whole} 个苹果。右边刚才有几个？`
  };
}

export function createCompositionBoard(task) {
  if (!isCompositionModel(task)) return null;
  return {
    whole: task.composition.whole,
    leftTarget: task.composition.left,
    left: 0,
    right: 0,
    phase: "left"
  };
}

export function moveCompositionBoard(board, action) {
  if (!board) return null;
  if (action === "restart" && board.phase === "answer") {
    return { ...board, left: 0, right: 0, phase: "left" };
  }
  const remaining = board.whole - board.left - board.right;
  if (action === "left" && board.phase === "left" && remaining > 0) {
    const left = board.left + 1;
    return { ...board, left, phase: left === board.leftTarget ? "right" : "left" };
  }
  if (action === "right" && board.phase === "right" && remaining > 0) {
    const right = board.right + 1;
    return { ...board, right, phase: remaining === 1 ? "join" : "right" };
  }
  if (action === "join" && board.phase === "join") {
    return { ...board, phase: "answer" };
  }
  return board;
}
