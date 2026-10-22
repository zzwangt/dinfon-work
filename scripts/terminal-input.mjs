export async function hiddenQuestion(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('请在终端交互输入密码，不使用命令行参数。');
  process.stdout.write(prompt);
  const input = process.stdin;
  input.setEncoding('utf8'); input.setRawMode(true); input.resume();
  return new Promise((resolveAnswer, reject) => {
    let value = '';
    const done = error => { input.off('data', onData); input.setRawMode(false); input.pause(); process.stdout.write('\n'); if (error) reject(error); else resolveAnswer(value); };
    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\u0003') return done(new Error('已取消。'));
        if (char === '\r' || char === '\n') return done();
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
        else if (char >= ' ' && value.length < 256) value += char;
      }
    };
    input.on('data', onData);
  });
}
