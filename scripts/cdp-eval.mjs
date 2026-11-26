// Evaluate an expression in an already-running page over the DevTools protocol,
// for example an Android WebView forwarded with
//   adb forward tcp:9339 localabstract:webview_devtools_remote_<pid>
// or the iPhone app's page through `pymobiledevice3 webinspector cdp`.
//
//   node scripts/cdp-eval.mjs <port> '<expression>'
//
// Fails, rather than waiting, when the page does not answer within 15 s.
const [port, expression] = process.argv.slice(2);
const target = (await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json())).find(t => t.type === 'page');
if (!target) {
  console.error(`cdp-eval: no page on port ${port}`);
  process.exit(1);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id !== 1) return;
  const r = m.result;
  console.log(JSON.stringify(r?.exceptionDetails ?? r?.result?.value ?? r, null, 1));
  process.exit(0);
});
ws.addEventListener('close', () => {
  console.error('cdp-eval: the page closed the connection without a reply');
  process.exit(1);
});
setTimeout(() => {
  console.error('cdp-eval: no reply within 15 s');
  process.exit(1);
}, 15000);
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
