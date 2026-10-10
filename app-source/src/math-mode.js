import { DIGIT_HINTS } from "./targeted-hints.js";
import { compositionInstructions } from "./composition-board.js";

export const MATH_STAGES = Object.freeze([
  { stage: 1, title: "数字与数量 0～5", detail: "看懂数字、听数指认，并把数字和实物数量对应起来。" },
  { stage: 2, title: "数字与数量 6～10", detail: "扩展到 10，继续坚持数字与数量同时理解。" },
  { stage: 3, title: "比较与顺序", detail: "学习多与少、前一个和后一个、相邻数与数序。" },
  { stage: 4, title: "分与合", detail: "用看得见的数量理解 2～5 可以怎样分开和合起来。" },
  { stage: 5, title: "5 以内加减", detail: "先看实物变化，再过渡到简单的数字算式。" },
  { stage: 6, title: "10 以内加减", detail: "看图理解添上和拿走，再练习 10 以内加减，包含 0 和得数 10。" }
]);

const STATUS_RANK = Object.freeze({ "未学": 0, "初见": 1, "学习中": 2, "薄弱": 2, "理解": 3, "稳定掌握": 4 });

function statusRank(status) {
  return STATUS_RANK[status] ?? 0;
}

function shuffled(values, random = Math.random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1));
    [result[index], result[selected]] = [result[selected], result[index]];
  }
  return result;
}

function shuffleTaskOptions(task, random) {
  return task.options ? { ...task, options: shuffled(task.options, random) } : task;
}

function digitOptions(answer) {
  const selected = [answer];
  for (let distance = 1; selected.length < 4; distance += 1) {
    for (const candidate of [answer + distance, answer - distance]) {
      if (candidate >= 0 && candidate <= 10 && !selected.includes(candidate)) selected.push(candidate);
      if (selected.length === 4) break;
    }
  }
  const values = selected.map(String);
  const shift = Math.abs(Number(answer)) % values.length;
  return [...values.slice(shift), ...values.slice(0, shift)];
}

function objects(number, emoji) {
  if (number === 0) return "🧺 空盘子";
  return Array.from({ length: number }, () => emoji).join(" ");
}

function quantityHint(number, name) {
  if (number === 0) return `盘子里没有${name}。想想“一个也没有”用哪个数字表示。`;
  if (number === 1) return `把眼前完整的${name}算作一份，不要把它的各个部分分开数。`;
  if (number === 2) return `先点左边的${name}，再点右边的。最后报到几，就选几。`;
  const lead = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"][number - 1];
  return `先从左边点出${lead}个${name}，记住刚报过的数。最后还没点到的接着数，不要从一重新开始。`;
}

function baseTask(item, variant, taskPrefix) {
  return {
    taskId: `${taskPrefix}-${item.ref.toLowerCase()}-${variant + 1}`,
    subject: "math",
    questionType: "choice",
    evidenceType: variant % 2 === 0 ? "math_visual_model" : "math_transfer",
    isNew: item.status === "未学",
    target: { ref: item.ref, display: item.display || item.value },
    context: "先看清题目，再慢慢想。"
  };
}

export function arithmeticPairs(kind, level = 10) {
  const limit = Number(level) <= 5 ? 5 : 10;
  const pairs = kind === "addition" ? [[2, 1], [2, 2]] : [[3, 1], [5, 2]];
  for (let left = 0; left <= limit; left += 1) {
    for (let right = 0; right <= limit; right += 1) {
      const valid = kind === "addition" ? left + right <= limit : right <= left;
      if (valid && !pairs.some(pair => pair[0] === left && pair[1] === right)) pairs.push([left, right]);
    }
  }
  return pairs;
}

export function mathVariantCount(item) {
  if (["addition", "subtraction"].includes(item.kind)) return arithmeticPairs(item.kind, item.level).length * 2;
  if (item.kind === "composition") return Math.max(1, Number(item.number) - 1) * 2;
  return 2;
}

export function buildMathTask(item, variant = 0, taskPrefix = "math") {
  const task = baseTask(item, variant, taskPrefix);
  const number = Number(item.number);

  if (item.kind === "digit") {
    const listenOnly = variant % 2 === 1;
    return {
      ...task,
      questionType: listenOnly ? "choice" : "recognition",
      evidenceType: listenOnly ? "math_digit_listening" : "math_digit_reading",
      prompt: listenOnly ? "听一听，找到我读到的数字。" : "请说出屏幕上的数字。",
      speechPrompt: listenOnly ? `找到数字 ${number}，只要告诉我第几个。` : "请说出屏幕上的数字。",
      visualPrompt: listenOnly ? "🔊" : String(number),
      ...(listenOnly ? { options: digitOptions(number) } : {}),
      correctAnswer: String(number),
      context: listenOnly ? "认真听清数字，再从四个选项里找。" : "先自己想一想，再大声说出来。",
      hint: DIGIT_HINTS[number],
      demonstration: number === 0 ? "这是数字 0，表示一个也没有。" : `这是数字 ${number}。跟我读：${number}。`,
      reinforcement: number === 0 ? "数字 0，表示一个也没有。" : `这是数字 ${number}。`
    };
  }

  if (item.kind === "quantity") {
    const emoji = variant % 2 === 0 ? "🍎" : "⭐";
    return {
      ...task,
      prompt: "数一数，一共有几个？",
      speechPrompt: "请看题目，数一数一共有几个。",
      visualPrompt: objects(number, emoji),
      options: digitOptions(number),
      correctAnswer: String(number),
      hint: quantityHint(number, emoji === "🍎" ? "苹果" : "星星"),
      demonstration: number === 0 ? "一个也没有，数量就是 0。" : `从左到右一个一个数，共有 ${number} 个。`,
      reinforcement: `数字 ${number} 可以表示 ${number} 个物品。`
    };
  }

  if (item.kind === "compare_more" || item.kind === "compare_less") {
    const left = variant % 2 === 0 ? 4 : 2;
    const right = variant % 2 === 0 ? 2 : 5;
    const asksMore = item.kind === "compare_more";
    const correctAnswer = asksMore
      ? left > right ? "左边" : "右边"
      : left < right ? "左边" : "右边";
    return {
      ...task,
      prompt: asksMore ? "哪一边的苹果更多？" : "哪一边的苹果更少？",
      speechPrompt: asksMore ? "数一数，哪一边的苹果更多？" : "数一数，哪一边的苹果更少？",
      visualPrompt: `左边：${objects(left, "🍎")}\n右边：${objects(right, "🍎")}`,
      options: ["左边", "右边", "一样多", "两边都没有"],
      correctAnswer,
      hint: `把左边的 ${left} 个苹果和右边的 ${right} 个苹果，一个配一个。${asksMore ? "配完还有剩的那边更多。" : "先配完、没有剩的那边更少。"}`,
      demonstration: `左边有 ${left} 个，右边有 ${right} 个，所以${correctAnswer}${asksMore ? "更多" : "更少"}。`,
      reinforcement: asksMore ? "数量大的那一边更多。" : "数量小的那一边更少。"
    };
  }

  if (["next_number", "previous_number", "missing_number"].includes(item.kind)) {
    const offset = variant % 2;
    let answer;
    let visualPrompt;
    let prompt;
    if (item.kind === "next_number") {
      const current = Math.min(9, number + offset);
      answer = current + 1;
      visualPrompt = `${current - 1}，${current}，？`;
      prompt = "后面应该是哪个数字？";
    } else if (item.kind === "previous_number") {
      const current = Math.max(2, number - offset);
      answer = current - 1;
      visualPrompt = `？，${current}，${current + 1}`;
      prompt = "前面应该是哪个数字？";
    } else {
      answer = number + offset;
      visualPrompt = `${answer - 2}，${answer - 1}，？，${answer + 1}`;
      prompt = "空格里应该放哪个数字？";
    }
    return {
      ...task,
      prompt,
      speechPrompt: `${visualPrompt.replace("？", "空格")}。${prompt}`,
      visualPrompt,
      options: digitOptions(answer),
      correctAnswer: String(answer),
      hint: item.kind === "next_number"
        ? `从 ${answer - 1} 接着往后数一个，就走到问号那里了。`
        : item.kind === "previous_number"
          ? `从 ${answer + 1} 往前退一个。可以摆出 ${answer + 1} 个小物品，拿走一个再数。`
          : `先读 ${answer - 2}、${answer - 1}，再往后数一个。填好后还要能接上 ${answer + 1}。`,
      demonstration: `按顺序数到这里，空格里应该是 ${answer}。`,
      reinforcement: `数字顺序里，${answer} 在这里。`
    };
  }

  if (item.kind === "composition") {
    const first = Math.floor(variant / 2) % (number - 1) + 1;
    const answer = number - first;
    const model = variant % 2 === 0;
    const composition = { whole: number, left: first };
    return {
      ...task,
      evidenceType: model ? "math_visual_model" : "math_transfer",
      composition,
      prompt: model ? "把苹果分到两个盘子，再找一找右边有几个。" : "想一想，空格里是几？",
      speechPrompt: model ? compositionInstructions(composition).left : `${number} 可以分成 ${first} 和几？`,
      ...(model ? {} : { visualPrompt: `${number} ＝ ${first} ＋ ？` }),
      options: digitOptions(answer),
      correctAnswer: String(answer),
      context: model ? "点盘子，一次放一个苹果。先分开，再合起来数。" : "可以摆出同样多的小物品，分到两边再数。",
      hint: model
        ? `点“再摆一次”。左边先放 ${first} 个，再一个一个数右边；合起来还是 ${number} 个。`
        : `摆出 ${number} 个一样的小物品，左边放 ${first} 个，再数右边。`,
      demonstration: `${number} 可以分成 ${first} 和 ${answer}，合起来还是 ${number}。`,
      reinforcement: `${first} 和 ${answer} 合起来是 ${number}。`
    };
  }

  if (item.kind === "addition" || item.kind === "subtraction") {
    const addition = item.kind === "addition";
    const level = Number(item.level) || 5;
    const pairs = arithmeticPairs(item.kind, level);
    const pair = pairs[Math.floor(variant / 2) % pairs.length];
    const model = variant % 2 === 0;
    const answer = addition ? pair[0] + pair[1] : pair[0] - pair[1];
    const operator = addition ? "+" : "−";
    const operationName = addition ? "加" : "减";
    const equation = `${pair[0]} ${operator} ${pair[1]} ＝ ？`;
    return {
      ...task,
      evidenceType: model ? "math_arithmetic_model" : "math_arithmetic_equation",
      prompt: model ? (addition ? "合起来一共有几个？" : "拿走后，还剩几个？") : "算一算，选出正确答案。",
      speechPrompt: `${pair[0]} ${operationName} ${pair[1]} 等于几？`,
      visualPrompt: model
        ? `${addition ? "先有" : "原来"}：${objects(pair[0], "🍎")}\n${addition ? "又添" : "拿走"}：${pair[1] ? objects(pair[1], "🍎") : addition ? "没有添上" : "没有拿走"}\n${equation}`
        : equation,
      options: digitOptions(answer),
      correctAnswer: String(answer),
      hint: addition
        ? `先摆 ${pair[0]} 个小物品，再添 ${pair[1]} 个。加号表示合起来，把两堆放一起数。`
        : `先摆 ${pair[0]} 个小物品，拿走 ${pair[1]} 个。减号表示拿走，只数还留下的。`,
      demonstration: `${pair[0]} ${operationName} ${pair[1]} 等于 ${answer}。`,
      reinforcement: `${pair[0]} ${operationName} ${pair[1]}，答案是 ${answer}。`,
      context: model ? "每一行都表示一个动作。先看原来的，再想变化后有多少。" : "可以用手指或小积木帮忙想。"
    };
  }

  throw new Error(`不支持的数学学习项：${item?.ref || "未知"}`);
}

export function mathStageProgress(items = []) {
  return MATH_STAGES.map(stage => {
    const stageItems = items.filter(item => Number(item.stage) === stage.stage);
    const learned = stageItems.filter(item => item.status && item.status !== "未学").length;
    const ready = stageItems.filter(item => statusRank(item.status) >= 2).length;
    return { ...stage, total: stageItems.length, learned, ready };
  });
}

export function activeMathStage(items = []) {
  const progress = mathStageProgress(items);
  return progress.find(stage => stage.ready < stage.total)?.stage || MATH_STAGES.at(-1).stage;
}

function reviewPriority(left, right) {
  const rankDifference = statusRank(left.status) - statusRank(right.status);
  if (rankDifference) return rankDifference;
  const errorDifference = (Number(right.incorrectCount) || 0) - (Number(left.incorrectCount) || 0);
  if (errorDifference) return errorDifference;
  return (Number(left.order) || 0) - (Number(right.order) || 0);
}

function arithmeticTrainingTasks(items, stage, random) {
  const arithmetic = items.filter(item => Number(item.stage) === stage);
  const warmupRefs = stage === 6 ? ["M-QTY-6", "M-COMP-5"] : ["M-COMP-4", "M-COMP-5"];
  const warmups = warmupRefs.map(ref => items.find(item => item.ref === ref)).filter(Boolean)
    .map(item => buildMathTask(item, item.kind === "composition"
      ? Math.floor(random() * (statusRank(item.status) >= 3
        ? mathVariantCount(item) / 2
        : Math.min(2, mathVariantCount(item) / 2))) * 2
      : Math.floor(random() * mathVariantCount(item)), `math-warmup-s${stage}`));
  const groups = arithmetic.map(item => {
    const pairs = arithmeticPairs(item.kind, item.level);
    const amount = pair => item.kind === "addition" ? pair[0] + pair[1] : pair[0];
    const zero = pair => pair[0] === 0 || pair[1] === 0 || (item.kind === "subtraction" && pair[0] === pair[1]);
    const choose = candidates => shuffled(candidates, random)[0];
    const indices = pairs.map((_, index) => index);
    const selected = [
      choose(indices.filter(index => !zero(pairs[index]) && amount(pairs[index]) <= Math.min(5, Number(item.level) - 1))),
      choose(indices.filter(index => !zero(pairs[index]) && amount(pairs[index]) === Number(item.level))),
      choose(indices.filter(index => zero(pairs[index])))
    ].filter(index => index != null);
    for (const index of shuffled(indices.filter(index => !selected.includes(index) && !zero(pairs[index])
      && (stage === 5 || amount(pairs[index]) > 5)), random)) {
      if (selected.length >= 5) break;
      selected.push(index);
    }
    return [...new Set(selected)].map((index, position) => buildMathTask(item, index * 2 + (position < 2 ? 0 : 1), `math-lesson-s${stage}`));
  });
  return [...warmups, ...Array.from({ length: 5 }, (_, index) => groups.map(group => group[index]).filter(Boolean)).flat()];
}

function compositionLessonItems(items, random) {
  const lastStart = Math.max(0, items.length - 2);
  const firstUnsteady = items.findIndex(item => statusRank(item.status) < 3);
  const start = firstUnsteady < 0
    ? Math.floor(random() * (lastStart + 1))
    : Math.min(firstUnsteady, lastStart);
  return items.slice(start, start + 2);
}

export function buildMathLesson(items = [], now = new Date(), { stage: requestedStage, random = Math.random } = {}) {
  const catalog = [...items].sort((left, right) => (Number(left.order) || 0) - (Number(right.order) || 0));
  const stage = MATH_STAGES.some(value => value.stage === Number(requestedStage)) ? Number(requestedStage) : activeMathStage(catalog);
  const stageItems = catalog.filter(item => Number(item.stage) === stage);
  const reviews = catalog
    .filter(item => item.status && item.status !== "未学" && Number(item.stage) <= stage)
    .sort(reviewPriority)
    .slice(0, 2);
  const newItems = stageItems.filter(item => !item.status || item.status === "未学").slice(0, 4);
  const fallback = newItems.length
    ? []
    : stageItems.filter(item => !reviews.some(review => review.ref === item.ref)).sort(reviewPriority).slice(0, 4);
  const selected = [...reviews, ...newItems, ...fallback];
  const stage4Items = stage === 4 ? compositionLessonItems(stageItems, random) : [];
  const tasks = stage >= 5 ? arithmeticTrainingTasks(catalog, stage, random) : stage === 4
    ? stage4Items.flatMap(item => {
      const pairCount = statusRank(item.status) >= 3
        ? mathVariantCount(item) / 2
        : Math.min(2, mathVariantCount(item) / 2);
      const pair = Math.floor(random() * pairCount);
      return [0, 1].map(offset => buildMathTask(item, pair * 2 + offset, `math-lesson-s${stage}`));
    })
    : selected.flatMap(item => {
    const variants = item.status === "未学"
      ? Array.from({ length: Math.min(2, mathVariantCount(item)) }, (_, index) => index)
      : [Math.floor(random() * mathVariantCount(item))];
    return variants.map(variant => buildMathTask(item, variant, `math-lesson-s${stage}`));
  }).slice(0, 12);
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const stageTitle = MATH_STAGES.find(value => value.stage === stage)?.title || "数学启蒙";
  return {
    protocol: "FAMILY_LEARNING_LESSON_V1",
    schemaVersion: 1,
    lessonId: `math-${stamp}-${crypto.randomUUID().slice(0, 8)}`,
    generatedAt: now.toISOString(),
    basedOnSessionIds: [],
    isBootstrap: false,
    title: `数学第 ${stage} 阶段 · ${stageTitle}`,
    teacherNote: "六个阶段均可自主选择。运算课先做数量与分合热身，再看图和算式；选课不会改变正式学习状态。",
    metadata: {
      estimatedMinutes: Math.max(5, Math.ceil(tasks.length * 0.8)),
      mathStage: stage,
      newMathRefs: [...new Set(tasks.filter(task => task.isNew).map(task => task.target.ref))]
    },
    tasks: tasks.map(task => shuffleTaskOptions(task, random))
  };
}

export function buildMathPracticeTasks(items = [], maxTasks = 10, random = Math.random) {
  return [...items]
    .filter(item => item.status && item.status !== "未学")
    .sort(reviewPriority)
    .slice(0, maxTasks)
    .map(item => shuffleTaskOptions({ ...buildMathTask(item, Math.floor(random() * mathVariantCount(item)), "math-practice"), isNew: false }, random));
}

export function buildMathTestTasks(items = [], random = Math.random, maxTasks = items.length) {
  return shuffled(items, random)
    .slice(0, maxTasks)
    .map(item => shuffleTaskOptions({ ...buildMathTask(item, Math.floor(random() * mathVariantCount(item)), "math-test"), isNew: false }, random));
}

export function buildAllMathVoiceTasks(items = []) {
  return items.flatMap(item => Array.from({ length: mathVariantCount(item) }, (_, variant) =>
    ({ ...buildMathTask(item, variant, "math-voice"), isNew: false })));
}
