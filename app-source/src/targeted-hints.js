import { HANZI_HINTS, HANZI_READING_EXAMPLES } from "./hanzi-hints.js";
import { naturalHanziClue } from "./natural-hints.js";

export const LETTER_HINTS = Object.freeze({
  A: ["像尖尖的小帐篷，中间有一根横杆。", "小写像圆肚子右边带一条小尾巴。"],
  B: ["左边一根竖线，右边上下各有一个圆肚子。", "小写的长竖在左，圆肚子在右下。"],
  C: ["像圆圈张开了嘴，开口朝右。", "小写也像朝右开口的小月牙。"],
  D: ["左边一根竖线，右边只有一个大圆肚子。", "小写的圆肚子在左下，长竖在右。"],
  E: ["一根竖线向右伸出三横，上、中、下都有。", "小写像小圆圈里伸出一条横，右边留个口。"],
  F: ["一根竖线向右伸出两横，最下面没有横线。", "小写顶部弯弯，腰间穿着一条横线。"],
  G: ["像朝右开口的圆圈，开口处向里伸进一小横。", "小写有圆肚子，下面还连着弯曲的笔画。"],
  H: ["左右两根竖线，中间搭一条横线，像小梯子。", "小写左边竖线高，右边拱起一个小门洞。"],
  I: ["像一根直直的小柱子，上下可以有短横。", "小写是短竖，头顶单独有一个点。"],
  J: ["长长的一笔，底部朝左弯出小钩。", "小写头顶有点，长竖的底部向左弯。"],
  K: ["左边一根竖线，右边两条斜线在中间相接。", "小写也在长竖右边伸出两条小斜线。"],
  L: ["一竖到底，再向右伸一横，像坐椅子的侧面。", "小写像一根高高的细竖线，顶上没有点。"],
  M: ["两边站得直，中间两条斜线落成一个尖谷。", "小写右边连着两个小拱门。"],
  N: ["左右两根竖线，用一条斜线从左上连到右下。", "小写右边只有一个小拱门。"],
  O: ["像完整的圆环，没有开口，也没有小尾巴。", "小写也是一个完整的小圆圈。"],
  P: ["左边长竖，右上一个圆肚子，右下空着。", "小写圆肚子在右，左边长竖向下伸。"],
  Q: ["一个圆圈，右下角多伸出一条小尾巴。", "小写圆肚子在左，右边长竖向下伸。"],
  R: ["右上有圆肚子，右下还伸出一条斜腿。", "小写竖线旁边有短短的小弯肩。"],
  S: ["像弯弯的小蛇，上下朝不同方向弯。", "小写也像缩小的弯弯小蛇。"],
  T: ["顶部一条横线，中间一根竖线垂下来。", "小写的横线穿过竖线靠上的位置，底部略弯。"],
  U: ["左右往下，底部圆圆地连起来，像小杯子。", "小写底部也圆圆的，右边带短竖。"],
  V: ["两条斜线在最下面碰头，底部是尖的。", "小写也是底部尖尖的，像张开的小夹子。"],
  W: ["像两个尖底的小杯子连在一起，有两个尖谷。", "小写也有两个相连的尖谷。"],
  X: ["两条斜线交叉，像一个小叉。", "小写也是两条斜线交叉。"],
  Y: ["上面两条斜线分叉，下面接一根竖，像小树枝。", "小写的斜线往下延伸，带一条尾巴。"],
  Z: ["上下一横，中间斜线从右上连到左下。", "小写像缩小的折线，上下都有横。"]
});

export const DIGIT_HINTS = Object.freeze([
  "像一个封闭的蛋形圈。盘子空空时，用它表示一个也没有。",
  "像一根直直的小棒。只伸出食指，想想伸出了几根。",
  "像小鸭弯着脖子，底部平平的。想想一双袜子有几只。",
  "右边上下两个弯，像贴在一起的小耳朵。红黄绿灯共有几盏？",
  "有交叉的横竖，像一面小旗。普通方桌通常有几条腿？",
  "顶部平平，中间转弯，底部有圆肚子。张开一只手数数手指。",
  "圆肚子在下面，弯弯的头在上面。数到五后再往后数一个。",
  "上面平平的一横，接着斜斜地往下，像折起来的小拐杖。",
  "上下各一个圆圈，像两个圆圈叠在一起。",
  "圆肚子在上面，长长的尾巴往下。它排在十的前面。",
  "左边一根小棒，右边一个圆圈。张开双手，数数全部手指。"
]);

const HANZI_CONTRASTS = Object.freeze({
  "木:本": "看横线下面：要找的字没有额外的小短横。",
  "木:禾": "看最顶端：要找的字没有额外的一撇。",
  "木:米": "看两边：要找的字没有那两笔额外的短笔画。",
  "本:木": "看竖线的下部：要找的字多一小横，像标出树根。",
  "禾:木": "看最顶端：要找的字多一撇，像低下来的穗子。",
  "日:月": "要找的是方框，里面只有一横，底部封住。",
  "月:日": "要找的是瘦长外框，里面有两横，下面伸出脚。",
  "日:目": "数数框里的横：要找的只有一横。",
  "目:日": "数数框里的横：要找的有两横。",
  "日:白": "看看最顶端：要找的方框上面没有短撇。",
  "白:日": "看看最顶端：要找的方框上面多一小撇。",
  "大:太": "看两条腿之间：要找的字没有额外的小点。",
  "大:天": "看看双臂上方：要找的字没有额外的一横。",
  "天:大": "看看最顶端：要找的字还多一横。",
  "人:入": "注意两笔相接的位置：左边的一撇从顶端起笔。",
  "土:士": "比较两横的长短：要找的字底下那横更长。",
  "士:土": "比较两横的长短：要找的字上面那横更长。",
  "牛:午": "看竖线的顶端：要找的竖要穿过上面那横。",
  "王:玉": "仔细找右下角：要找的字没有额外的一点。",
  "刀:力": "看左上角：要找的撇不会穿出横折钩的上方。",
  "力:刀": "看左上角：要找的撇要穿出横折钩的上方。",
  "他:她": "先认左边：要找的是单人旁。",
  "她:他": "先认左边：要找的是女字旁。",
  "火:灭": "看最顶端：要找的字上面没有盖着的一横。",
  "灭:火": "看最顶端：要找的字上面多一横，像把焰苗盖住。",
  "里:田": "看看方格下面：要找的字还连着土。",
  "支:枝": "看看左边：要找的字没有木字旁。"
});

const LETTER_CONTRASTS = Object.freeze({
  "B:D": "刚才选的只有一个大肚子。要找的在右边有上下两个肚子。",
  "B:P": "留意右下方：要找的那里也有一个圆肚子。",
  "B:R": "留意右下方：要找的是圆肚子，没有伸出的斜腿。",
  "D:B": "刚才选的有上下两个肚子。要找的右边只有一个大肚子。",
  "P:B": "留意右下方：要找的那里空空的，只在右上有圆肚子。",
  "R:P": "留意右下方：要找的还伸出一条斜腿。",
  "E:F": "看看最底部：要找的还多一条横线。",
  "F:E": "看看最底部：要找的没有横线。",
  "C:G": "看看圆弧的开口：要找的没有向里伸的小横。",
  "G:C": "看看圆弧的开口：要找的向里伸进一小横。",
  "O:Q": "看看右下角：要找的是完整圆圈，没有小尾巴。",
  "Q:O": "看看右下角：要找的圆圈还带一条小尾巴。",
  "M:N": "看中间：要找的有两条斜线，碰出一个尖谷。",
  "N:M": "看中间：要找的只有一条斜线连着左右。",
  "U:V": "看最底部：要找的是圆弯，像杯底。",
  "V:U": "看最底部：要找的是尖角，两条斜线在这里相碰。"
});

const HANZI_EXAMPLES = Object.freeze(Object.fromEntries(`
人 人们;大 大象;小 小猫;山 高山;水 喝水;火 火苗;木 木头;日 日光;月 月亮;田 田地;
一 一个;二 二月;三 三天;四 四季;五 五官;六 六月;七 七天;八 八月;九 九月;十 十指;
百 一百;千 一千;万 一万;零 零个;多 多少;少 很少;半 一半;双 双手;个 一个;只 一只小鸟;第 第一;
我 我们;你 你好;他 他们;她 她们;爸 爸爸;妈 妈妈;父 父亲;母 母亲;爷 爷爷;奶 牛奶;哥 哥哥;姐 姐姐;弟 弟弟;妹 妹妹;
儿 儿子;女 女孩;子 孩子;头 头顶;口 口水;手 手心;天 天空;雨 下雨;风 微风;土 泥土;马 小马;牛 小牛;羊 山羊;
门 开门;车 汽车;白 白云;中 中间;上 上面;下 下面;里 里面;开 开门;出 出门;有 没有;在 在家;两 两个;王 国王;几 几个;片 一片叶子;支 一支铅笔;刀 菜刀;灭 熄灭;
发 发芽;种 种子;教 教室;得 获得;行 步行;系 联系;转 转弯;倒 倒下;数 数字
`.trim().split(/;\s*/).map(entry => entry.trim().split(/\s+/))));

function targetValue(task) {
  return String(task?.correctAnswer || task?.target?.display || "").trim();
}

function letterValue(task) {
  return targetValue(task).match(/[A-Za-z]/)?.[0]?.toUpperCase() || "";
}

function contrastHint(task, childAnswer) {
  if (task?.questionType !== "choice" || !task.options?.includes(childAnswer)) return "";
  if (task.subject === "hanzi") {
    return HANZI_CONTRASTS[`${targetValue(task)}:${childAnswer}`] || "";
  }
  if (task.subject === "english_letter") {
    return LETTER_CONTRASTS[`${letterValue(task)}:${String(childAnswer).toUpperCase()}`] || "";
  }
  return "";
}

export function taskHint(task, childAnswer = null) {
  const contrast = contrastHint(task, childAnswer);
  if (task?.subject === "hanzi") {
    const entry = HANZI_HINTS[targetValue(task)];
    if (entry) {
      const shape = contrast || (task.questionType === "choice" ? entry.shape : "");
      return `${shape}${naturalHanziClue(targetValue(task), entry.clue)}`;
    }
  }
  if (task?.subject === "english_letter") {
    const entry = LETTER_HINTS[letterValue(task)];
    if (entry) return contrast || (task.questionType === "choice" ? entry[0] : `先看大写：${entry[0]}再看小写：${entry[1]}`);
  }
  const base = String(task?.hint || "").trim();
  if (task?.subject === "math" && childAnswer != null && task.options?.includes(childAnswer)) {
    const answer = Number(task.correctAnswer);
    const selected = Number(childAnswer);
    if (Number.isFinite(answer) && Number.isFinite(selected) && selected !== answer
        && !/^math_digit_/.test(task.evidenceType || "")) {
      return `${selected > answer ? "刚才选的数量偏多了。" : "刚才选的数量偏少了。"}${base}`;
    }
  }
  return base;
}

// 把所有可能出现的选错线索一并列出，语音包不能只覆盖某次随机选项。
export function taskHintVariants(task) {
  const variants = [taskHint(task)];
  if (task?.questionType === "choice") {
    const contrasts = task.subject === "hanzi" ? HANZI_CONTRASTS : task.subject === "english_letter" ? LETTER_CONTRASTS : {};
    const target = task.subject === "english_letter" ? letterValue(task) : targetValue(task);
    const possibleAnswers = Object.keys(contrasts).filter(key => key.startsWith(`${target}:`)).map(key => key.split(":")[1]);
    for (const answer of new Set([...(task.options || []), ...possibleAnswers])) {
      if (answer !== target) variants.push(taskHint({ ...task, options: [...(task.options || []), answer] }, answer));
    }
  }
  return [...new Set(variants)].filter(Boolean);
}

export function withTargetedHint(task) {
  return { ...task, hint: taskHint(task) };
}

export function hanziDemonstration(task) {
  if (task?.subject !== "hanzi") return "";
  const character = targetValue(task);
  const word = HANZI_READING_EXAMPLES[character] || HANZI_EXAMPLES[character];
  if (word) return `这是“${character}”，${word}的${character}。跟我读：${character}。`;
  const clue = HANZI_HINTS[character]?.clue;
  if (!clue) return "";
  const example = clue.split(/(?<=[。？！])/u).find(sentence => sentence.includes("□"));
  return example
    ? `这是“${character}”。${example.replaceAll("□", character)}跟我读：${character}。`
    : `这是“${character}”。${clue}跟我读：${character}。`;
}
