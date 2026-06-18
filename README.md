## 程序介绍 
> 自部署思源笔记同步感知节点（v4.7 - 3 端改造版）

## 使用教程
> 下载到服务器上，然后在根目录运行`npm i`，然后`npm run start`，程序会运行在7777端口
> 你可以配置`nginx`转发到`7777`端口，然后就可以通过域名访问了

## 协议说明

### Push 请求
- URL: `POST /`
- Headers: `userKey`, `action: push`, `Content-Type: application/json`
- Body: `{ "syncst": 1 }`（1 = 有新变更，0 = 心跳/正常）
- 保护规则：
  - 保护 1：心跳 syncst=0 不覆盖 syncst=1
  - 保护 2：syncst=1 重复 push 时刷新 needConsume，保留 consumedBy

### Pull 请求
- URL: `POST /`
- Headers: `userKey`, `action: pull`, `Content-Type: application/json`
- Body: `{}`
- Response: `{ "userKey": "...", "syncst": 0|1, "onlineCount": N }`

### Debug 端点
- `GET /debug` 返回当前 `data.json` 状态 + 最近 50 行日志

## 修改记录

### 2026-06-18 duyfgithub - v0.2.0 (3 端改造 v4.7)
- 新增 `deviceId|repoKey` userKey 模式
- 新增 push 保护1（心跳 syncst=0 不覆盖 syncst=1）
- 新增 push 保护2（syncst=1 重复 push 刷新 needConsume，保留 consumedBy）
- 新增 pull consumedBy 去重与同步清零
- 新增 pull 超时降级（在线设备不足时降低 needConsume）
- 新增 pull 清理过期条目（syncst=1 超过 10 分钟 / syncst=0 超过 5 分钟）
- 新增 `server.log` 日志与 `GET /debug` 调试接口
- 兼容旧设备：纯 repoKey 仍走原 userAgent 区分逻辑

### 2026-06-17 duyfgithub
- 新增"纯 repoKey 模式"支持：使用 `siyuan.config.repo.key` 作为 userKey，确保同一仓库的所有设备共享相同的 userKey
- 新增"appId|repoKey 模式"兼容：保留旧版脚本的 `appId|repoKey` 格式的设备兼容
- 新增跨设备感知：通过 userAgent 区分设备，避免本机 pull 时消费自己 push 的消息
- 优化数据清理：syncst=0 的条目在下次 pull 时自动删除
- 新增 GET / 健康检查接口
- 新增 `data.json` 到 .gitignore

## 配套客户端脚本

客户端使用 `siyuanjs_fixed.js`（v0.2.0），需要：
1. 思源笔记 → 设置 → 代码片段
2. 把脚本内容粘贴进去并启用
3. 重启思源笔记

`siyuanjs_fixed.js` 关键改动：
- `genUserKey()` 返回 `deviceId|repoKey`
- 启动时立即 `push syncst=0`（注册心跳）
- 每 5 秒轮询：先 `push(0)` 心跳，再 `pull` 检查
- pull 触发的同步不再 `push syncst=1`（`isPullTriggeredSync`）
- pull 返回的 `onlineCount` 回填到 `getOtherClientCount()`
- 客户端日志已关闭（`debug = false`），仅保留 `console.warn` 错误输出

---

# 思源同步感知 3 端改造方案（v4.7）

## 核心思路

**服务器维护"已消费设备列表"，所有在线消费者都消费完后才清除 syncst。**

- 2 台在线：A push → B 消费 → syncst=0
- 3 台在线：A push → B 消费 → C 消费 → syncst=0
- 超时降级：C 超时 30 秒 → 降到 2 台 → B 已消费 → syncst=0

## 修复记录

| 版本 | 修复 |
|------|------|
| v4 → v4.1 | consumeCount 重复计数；超时降级误清 |
| v4.1 → v4.2 | 心跳 syncst=0 覆盖 syncst=1 |
| v4.2 → v4.3 | needConsume=0 时 syncst 立即清除 |
| v4.3 → v4.5 | 连锁反应；syncst=1 重复 push 问题 |
| v4.5 → v4.6 | 文档矛盾修复：push/客户端代码与场景一致 |
| v4.6 → v4.7 | 场景描述文字错误修正 |

## 数据结构

```json
{
  "A|K15ff...": {
    "syncst": 1,
    "ua": "Linux",
    "lastHeartbeat": 1234567890,
    "needConsume": 2,
    "consumedBy": []
  }
}
```

- `needConsume`：需要多少个其他设备消费（push 时设置 = 在线设备数 - 1，最小值 1）
- `consumedBy`：已消费的设备 deviceId 列表

## 用户 Key 格式

`deviceId|repoKey`

- `deviceId`：`siyuan.config.system.id`，fallback localStorage
- `repoKey`：`siyuan.config.repo.key`

## 服务器 push 逻辑

```javascript
function pushHandler(userKey, syncst) {
  const myRepo = getRepoFromKey(userKey);
  const now = Date.now();
  
  // 保护 1：心跳 syncst=0 不覆盖 syncst=1
  if (data[userKey] && data[userKey].syncst === 1 && syncst === 0) {
    data[userKey].lastHeartbeat = now;
    data[userKey].userAgent = userAgent;
    return;
  }
  
  // 保护 2：syncst=1 重复 push，更新 needConsume，保留 consumedBy
  if (data[userKey] && data[userKey].syncst === 1 && syncst === 1) {
    const onlineDevices = [];
    for (const [key, entry] of Object.entries(data)) {
      const repo = getRepoFromKey(key);
      if (repo === myRepo && key !== userKey && now - entry.lastHeartbeat <= 30000) {
        onlineDevices.push(key);
      }
    }
    data[userKey].needConsume = Math.max(onlineDevices.length, 1);
    data[userKey].lastHeartbeat = now;
    data[userKey].userAgent = userAgent;
    return;
  }
  
  // 新条目
  const onlineDevices = [];
  for (const [key, entry] of Object.entries(data)) {
    const repo = getRepoFromKey(key);
    if (repo === myRepo && key !== userKey && now - entry.lastHeartbeat <= 30000) {
      onlineDevices.push(key);
    }
  }
  
  data[userKey] = {
    syncst: syncst,
    userAgent: userAgent,
    lastHeartbeat: now,
    needConsume: syncst === 1 ? Math.max(onlineDevices.length, 1) : 0,
    consumedBy: []
  };
}
```

## 服务器 pull 逻辑

```javascript
function pullHandler(userKey) {
  const myDevice = getDeviceFromKey(userKey);
  const myRepo = getRepoFromKey(userKey);
  const now = Date.now();
  
  if (data[userKey]) {
    data[userKey].lastHeartbeat = now;
  }
  
  let hasSync = false;
  
  for (const [key, entry] of Object.entries(data)) {
    const repo = getRepoFromKey(key);
    const device = getDeviceFromKey(key);
    if (repo !== myRepo || device === myDevice) continue;
    
    if (entry.syncst === 1) {
      hasSync = true;
      if (!entry.consumedBy) entry.consumedBy = [];
      if (!entry.consumedBy.includes(myDevice)) {
        entry.consumedBy.push(myDevice);
      }
      if (entry.consumedBy.length >= entry.needConsume) {
        entry.syncst = 0;
      }
    }
  }
  
  for (const [key, entry] of Object.entries(data)) {
    const repo = getRepoFromKey(key);
    if (repo !== myRepo || entry.syncst !== 1) continue;
    let onlineCount = 0;
    for (const [k2, e2] of Object.entries(data)) {
      const r2 = getRepoFromKey(k2);
      if (r2 === myRepo && k2 !== key && now - e2.lastHeartbeat <= 30000) onlineCount++;
    }
    if (onlineCount < entry.needConsume) {
      entry.needConsume = Math.max(onlineCount, 1);
      if (entry.consumedBy.length >= entry.needConsume) entry.syncst = 0;
    }
  }
  
  for (const [key, entry] of Object.entries(data)) {
    if (entry.syncst === 1 && now - entry.lastHeartbeat > 10 * 60 * 1000) delete data[key];
    if (entry.syncst === 0 && now - entry.lastHeartbeat > 5 * 60 * 1000) delete data[key];
  }
  
  let onlineCount = 0;
  for (const [key, entry] of Object.entries(data)) {
    const repo = getRepoFromKey(key);
    if (repo === myRepo && now - entry.lastHeartbeat <= 30000) onlineCount++;
  }
  
  return { syncst: hasSync ? 1 : 0, onlineCount };
}
```

## 客户端逻辑

```javascript
// genUserKey
function genUserKey() {
  const repoKey = siyuan.config.repo.key;
  const deviceId = siyuan.config.system?.id
    || localStorage.getItem('syncDeviceId')
    || (() => {
        const id = Math.random().toString(36).slice(2, 10);
        localStorage.setItem('syncDeviceId', id);
        return id;
      })();
  return encodeURIComponent(deviceId + '|' + repoKey);
}

// 启动心跳
await pushSyncStatus(0);

// 轮询（每 5 秒）
setInterval(async () => {
  await pushSyncStatus(0);
  const data = await pullSyncStatus();
  if (data && data.syncst === 1) {
    isPullTriggeredSync = true;
    await sync();
    isPullTriggeredSync = false;
  }
}, 5000);

// 同步完成后（仅本地修改才 push syncst=1）
const result = await sync();
if (result && result.code === 0) {
  if (!isPullTriggeredSync) {
    await pushSyncStatus(1);
  }
}
```

## 场景验证

### 场景 1：A 修改，B 和 C 感知

```
T0  A 本地修改 → sync 完成 → push syncst=1
    → {A:syncst=1,needConsume=2,consumedBy:[]}
T1  A 心跳 push syncst=0 → 保护：只更新 hb → syncst 仍为 1
T2  B pull → consumedBy:[B] → len=1 < 2 → 返回 1 → B 同步（pull触发，不push）
T3  C pull → consumedBy:[B,C] → len=2 >= 2 → syncst=0 → 返回 1 → C 同步（pull触发，不push）
T4  B/C 心跳 push syncst=0
T5  所有 pull → syncst=0 ✅
```

### 场景 2：A 连续修改两次

```
T0  A 修改1 → push syncst=1 → {A:syncst=1,needConsume=2,consumedBy:[]}
T1  B pull → consumedBy:[B] → len=1 < 2 → 返回 1 → B 同步
T2  A 修改2 → push syncst=1
    → 保护2：needConsume=2，consumedBy 仍为 [B]
T3  C pull → consumedBy:[B,C] → len=2 >= 2 → syncst=0 → 返回 1 → C 同步
```

B 在 T1 同步时拿到第一次修改。C 在 T3 同步时拿到两次修改。B 的第二次修改通过 S3/WebDAV 同步拿到。

### 场景 3：A 和 B 同时修改

```
T0  A push syncst=1 → {A:syncst=1,needConsume=2,consumedBy:[]}
T0  B push syncst=1 → {B:syncst=1,needConsume=2,consumedBy:[]}

T1  C pull → A:consumedBy:[C], B:consumedBy:[C] → 返回 1 → C 同步
T2  A pull → B:consumedBy:[A] → 返回 1 → A 同步
T3  B pull → A:consumedBy:[A,B] → len=2>=2 → A.syncst=0
    → B 自己跳过 → hasSync=true → 返回 1 → B 同步
T4  A pull → B:consumedBy:[A,B] → len=2>=2 → B.syncst=0 → 返回 0
T5  所有 pull → syncst=0 ✅
```

### 场景 4：C 超时降级

```
T0  A push → {A:syncst=1,needConsume=2,consumedBy:[]}
T1  B pull → consumedBy:[B] → len=1 < 2 → 返回 1
T2  B 自然轮询 pull → 超时降级：onlineCount=1(B) → needConsume 降为 1
    → consumedBy:[B], len=1 >= 1 → syncst=0 ✅
```

### 场景 5：A 唯一在线

```
T0  A push → {A:syncst=1,needConsume=1,consumedBy:[]}
T1  A pull → 跳过自己 → 返回 0 → consumedBy 仍为 [] → syncst 保持 1
T30 B 上线 → pull → consumedBy:[B] → len=1 >= 1 → syncst=0 ✅
```

### 场景 6：B 和 C 都超时

```
T0  A push → needConsume=2, consumedBy:[]
T0+30s  A pull → onlineCount=0 → needConsume 降为 1 → len=0 < 1
T0+60s  A pull → 同上 → syncst 保持 1
T0+10min  清理 → delete A 条目 ✅
```

## Bug 修复总结

| Bug | 修复 |
|-----|------|
| consumeCount 重复计数 | consumedBy + includes |
| 超时降级误清 | needConsume 降级后重新检查 |
| 心跳覆盖 syncst=1 | syncst=0 只更新 hb |
| needConsume=0 立即清除 | 最小值 1 |
| syncst=1 重复 push | 保护2：更新 needConsume，保留 consumedBy |
| 连锁反应 | pull 触发的同步不 push syncst=1 |
| 文档矛盾 | push/客户端代码与场景一致 |
| 场景描述文字错误 | v4.7 修正（场景3返回值、场景4触发方式） |

## 文件改动清单

### `siyuanjs_fixed.js`

| 改动 | 说明 |
|------|------|
| genUserKey() | `{deviceId}\|{repoKey}` |
| deviceId | `siyuan.config.system.id`，fallback localStorage |
| 启动 push syncst=0 | 注册心跳 |
| 轮询 push syncst=0 + pull | 心跳 + 拉取 |
| isPullTriggeredSync | pull 触发的同步不 push syncst=1 |
| pull 返回 | `{syncst, onlineCount}` |

### `aware.js`

| 改动 | 说明 |
|------|------|
| push 保护1 | syncst=0 不覆盖 syncst=1 |
| push 保护2 | syncst=1 重复 → 更新 needConsume，保留 consumedBy |
| pull | consumedBy 去重 + 超时降级 + 清理 |
| 返回 | `{syncst, onlineCount}` |

## 兼容性

- 旧设备（纯 repoKey）：走策略1，保持原逻辑
- 新设备（deviceId|repoKey）：走策略2，consumedBy 模式
- 两种设备可同时在线，互不影响