/**
 * Vite 模板遗留演示计数器（可选示例钩子）。
 * Legacy Vite demo counter hook kept for template completeness.
 */

export function setupCounter(element: HTMLButtonElement) {
  let counter = 0
  const setCounter = (count: number) => {
    counter = count
    element.innerHTML = `count is ${counter}`
  }
  element.addEventListener('click', () => setCounter(counter + 1))
  setCounter(0)
}
