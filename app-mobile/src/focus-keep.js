// 重绘时保留输入焦点。
// 手机浏览器里，只要承载光标的输入框被从 DOM 中移除，系统就会收起软键盘，
// 家长刚输入到一半的验证码/手机号也会一起消失。因此凡是在「输入过程中」可能发生的
// 整页重绘，都必须先记录焦点与光标，重绘后交还给同一个输入框。
//
// 用法：
//   const snapshot = captureFocus(root, node => node.hasAttribute("data-login-phone") ? "[data-login-phone]" : null);
//   root.innerHTML = "...";
//   restoreFocus(root, snapshot);

export function captureFocus(root, selectorFor) {
  const active = document.activeElement;
  if (!active || !root.contains(active) || typeof active.hasAttribute !== "function") return null;
  let selector = null;
  try {
    selector = selectorFor(active);
  } catch {
    return null;
  }
  if (!selector) return null;
  return { selector, start: active.selectionStart, end: active.selectionEnd };
}

export function restoreFocus(root, snapshot) {
  if (!snapshot) return;
  const node = root.querySelector(snapshot.selector);
  if (!node) return;
  try {
    node.focus({ preventScroll: true });
    if (snapshot.start != null) node.setSelectionRange(snapshot.start, snapshot.end);
  } catch { /* number / range 等输入类型不支持选区，忽略。 */ }
}
