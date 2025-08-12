const re2 = require('re2-wasm');

re2().then(api => {
  window.RE2 = api;
});