// Evaluate an expression in an already-running page over the DevTools protocol,
// for example an Android WebView forwarded with
//   adb forward tcp:9339 localabstract:webview_devtools_remote_<pid>
//
//   node scripts/cdp-eval.mjs <port> '<expression>'
const [port, expression] = process.argv.slice(2);
const target = (await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json())).find(t => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id !== 1) return;
  const r = m.result;
  console.log(JSON.stringify(r?.exceptionDetails ?? r?.result?.value ?? r, null, 1));
  ws.close();
});
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
