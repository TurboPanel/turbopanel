export function poll() {
  setTimeout(() => {
    setTimeout(poll, 1000);
  }, 100);
}
