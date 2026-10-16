/*
 * Copyright 2026 Heartfilia
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * 解析 Worker：只负责把解析挪出主线程，真正的解析逻辑在 json-parser.js。
 * 主线程与 Worker 共用同一份实现，避免两边行为不一致。
 */

importScripts('./json-parser.js');

self.addEventListener('message', (event) => {
  const { id, input } = event.data || {};

  try {
    const result = self.SmartJSON.tryParse(input);
    self.postMessage({
      id,
      ok: result.ok,
      empty: Boolean(result.empty),
      value: result.value,
      mode: result.mode,
      detail: result.detail
    });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      detail: {
        summary: `解析失败：${error instanceof Error ? error.message : '未知错误'}`,
        reason: '存在语法错误',
        line: -1,
        column: -1,
        snippet: ''
      }
    });
  }
});
