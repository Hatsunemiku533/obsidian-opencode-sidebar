function errorSummary(value) {
  const message = typeof value === 'string' ? value : String(value?.message || '');
  const stack = typeof value === 'string' ? value : String(value?.stack || message);
  const context = message.match(/\b([A-Za-z]{1,40}) context must be used within a context provider/);
  const kinds = [
    ['context-provider', /context must be used within a context provider/],
    ['credential-url', /URL.*(?:includes|include|contains) credentials/i],
    ['session-not-found', /Session not found/i],
    ['chunk-load', /(?:dynamically imported module|ChunkLoadError|Loading chunk)/i],
    ['fetch-failed', /(?:Failed to fetch|NetworkError|Load failed)/i],
    ['content-security-policy', /(?:Content Security Policy|Refused to (?:load|execute|apply))/i],
    ['resize-observer', /ResizeObserver loop/i]
  ];
  const kind = kinds.find(([, pattern]) => pattern.test(message))?.[0] || 'other';
  const name = /^(?:Error|TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError)$/.test(value?.name)
    ? value.name : message.match(/\b(TypeError|ReferenceError|SyntaxError|RangeError)\b/)?.[1] || 'Error';
  const frames = Array.from(stack.matchAll(/\b([A-Za-z0-9_.-]{1,120}\.js):(\d+):(\d+)/g), (match) => ({
    file: match[1], line: Number(match[2]), column: Number(match[3])
  })).slice(0, 8);
  const code = /^(?:E[A-Z0-9_]{2,40}|ERR_[A-Z0-9_]{2,60}|CERT_[A-Z0-9_]{2,60})$/.test(value?.code) ? value.code : undefined;
  return { kind, name, ...(context ? { context: context[1] } : {}), ...(code ? { code } : {}), frames };
}

function safeErrorSummary(value = {}) {
  const kinds = ['context-provider', 'credential-url', 'session-not-found', 'chunk-load', 'fetch-failed', 'content-security-policy', 'resize-observer', 'other'];
  return {
    kind: kinds.includes(value.kind) ? value.kind : 'other',
    name: /^(?:Error|TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError)$/.test(value.name) ? value.name : 'Error',
    ...(value.kind === 'context-provider' && /^[A-Za-z]{1,40}$/.test(value.context) ? { context: value.context } : {}),
    ...(value.source && ['error', 'unhandledrejection', 'console'].includes(value.source) ? { source: value.source } : {}),
    frames: Array.isArray(value.frames) ? value.frames.filter((frame) => /^[A-Za-z0-9_.-]{1,120}\.js$/.test(frame?.file) &&
      Number.isSafeInteger(frame.line) && Number.isSafeInteger(frame.column) && frame.line >= 0 && frame.column >= 0)
      .slice(0, 8).map((frame) => ({ file: frame.file, line: frame.line, column: frame.column })) : []
  };
}

module.exports = { errorSummary, safeErrorSummary };
