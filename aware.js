/**
 * 自建思源同步感知节点（v4.7 - 3 端改造版）
 *
 * 核心思路：服务器维护"已消费设备列表（consumedBy）"，
 *          所有在线消费者都消费完后才清除 syncst。
 *
 * - 2 台在线：A push → B 消费 → syncst=0
 * - 3 台在线：A push → B 消费 → C 消费 → syncst=0
 * - 超时降级：C 超时 → needConsume 降低 → B 已消费 → syncst=0
 *
 * 兼容：
 * - 旧设备（纯 repoKey）：走策略1，保持原逻辑（userAgent 区分设备）
 * - 新设备（deviceId|repoKey）：走策略2，consumedBy 模式
 * - 两种设备可同时在线，互不影响
 */

const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 7777;

// 在线心跳阈值：30 秒内有过心跳视为在线
const ONLINE_TIMEOUT_MS = 30 * 1000;
// syncst=1 条目清理阈值：10 分钟无心跳则清理
const SYNCST1_CLEANUP_MS = 10 * 60 * 1000;
// syncst=0 条目清理阈值：5 分钟无心跳则清理
const SYNCST0_CLEANUP_MS = 5 * 60 * 1000;

app.use(cors());
app.use(bodyParser.json());

// ===================== 日志工具 =====================

const LOG_FILE = path.join(__dirname, 'server.log');

/**
 * 写一行带时间戳的日志，同时输出到 stdout 与 server.log 文件
 */
function logLine(level, msg, extra) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`;
    // 控制台
    process.stdout.write(line);
    // 异步追加到日志文件（避免阻塞请求）
    fs.appendFile(LOG_FILE, line, (err) => {
        if (err) console.error('[LOG] 写日志失败:', err.message);
    });
}

function logInfo(msg, extra) { logLine('INFO', msg, extra); }
function logWarn(msg, extra) { logLine('WARN', msg, extra); }
function logError(msg, extra) { logLine('ERROR', msg, extra); }
function logDebug(msg, extra) { logLine('DEBUG', msg, extra); }

// 启动时清空旧日志（可选；保留历史可注释掉此行）
try {
    fs.writeFileSync(LOG_FILE, `=== 服务启动 ${new Date().toISOString()} ===\n`);
} catch (e) {
    console.error('[LOG] 初始化日志文件失败:', e.message);
}

// ===================== 辅助函数 =====================

/**
 * 从 userKey 中提取 sync space（| 后面的部分，即 repoKey）。
 * - 新设备 userKey = "deviceId|repoKey" → 返回 repoKey
 * - 旧设备 userKey = "repoKey" → 返回 repoKey
 * 返回 null 仅在 userKey 为空时。
 * 统一返回 repoKey 后，新旧设备能匹配同一仓库。
 */
function getSyncSpace(userKey) {
    if (!userKey) return null;
    const pipeIndex = userKey.indexOf('|');
    if (pipeIndex === -1) return userKey;
    return userKey.substring(pipeIndex + 1);
}

/**
 * 从 userKey 中提取设备前缀（| 前面的部分）。
 * - 新设备返回 deviceId
 * - 旧设备（纯 repoKey）返回空串 ''，用于与新设备的 deviceId 区分
 */
function getDevicePrefix(userKey) {
    if (!userKey) return '';
    const pipeIndex = userKey.indexOf('|');
    if (pipeIndex === -1) return '';
    return userKey.substring(0, pipeIndex);
}

/**
 * 从 userKey 中提取设备前缀（| 前面的部分），不存在返回 userKey 本身
 */
function getDevicePrefix(userKey) {
    const pipeIndex = userKey.indexOf('|');
    if (pipeIndex === -1) return userKey;
    return userKey.substring(0, pipeIndex);
}

/**
 * 统计同一 repo 中当前在线设备数（不含 key 自己）
 */
function countOnlineDevices(data, myKey, myRepo) {
    const now = Date.now();
    let count = 0;
    for (const [key, entry] of Object.entries(data)) {
        const repo = getSyncSpace(key);
        if (repo !== myRepo) continue;
        if (key === myKey) continue;
        if (now - (entry.lastHeartbeat || 0) <= ONLINE_TIMEOUT_MS) {
            count++;
        }
    }
    return count;
}

// ===================== 路由 =====================

app.post('/', (req, res) => {
    const userKey = decodeURIComponent(req.headers['userkey'] || '');
    const action = req.headers['action'];
    const requestBody = req.body || {};
    const clientIp = (req.headers['x-forwarded-for'] || '').split(',').pop().trim();
    const userAgent = req.headers['user-agent'] || '';
    const now = Date.now();

    const filePath = path.join(__dirname, 'data.json');

    if (!userKey) {
        logWarn('POST 缺少 userKey 头');
        return res.status(400).json({ message: 'Missing userKey' });
    }

    if (action === 'push') {
        const syncst = requestBody.syncst;
        logInfo('PUSH 收到请求', { userKey, syncst, clientIp, ua: userAgent.slice(0, 60) });

        // 读取现有数据
        fs.readFile(filePath, 'utf8', (err, data) => {
            let jsonData = {};
            if (!err && data) {
                try {
                    jsonData = JSON.parse(data);
                } catch (parseErr) {
                    logError('PUSH 解析 JSON 错误', { err: parseErr.message });
                }
            }

            const myRepo = getSyncSpace(userKey); // 旧设备为 null
            const existing = jsonData[userKey];

            // ========== 新设备（deviceId|repoKey）：走 v4.7 逻辑 ==========
            if (myRepo !== null) {
                // 保护 1：心跳 syncst=0 不覆盖 syncst=1
                if (existing && existing.syncst === 1 && syncst === 0) {
                    existing.lastHeartbeat = now;
                    existing.userAgent = userAgent;
                    logInfo('PUSH 保护1触发：心跳 syncst=0 不覆盖 syncst=1', {
                        userKey,
                        consumedBy: existing.consumedBy,
                        needConsume: existing.needConsume
                    });
                    return writeAndRespond(jsonData, res, { message: '心跳忽略（syncst=1）' });
                }

                // 保护 2：syncst=1 重复 push，更新 needConsume，保留 consumedBy
                if (existing && existing.syncst === 1 && syncst === 1) {
                    const onlineCount = countOnlineDevices(jsonData, userKey, myRepo);
                    existing.needConsume = Math.max(onlineCount, 1);
                    existing.lastHeartbeat = now;
                    existing.userAgent = userAgent;
                    logInfo('PUSH 保护2触发：syncst=1 重复 push，刷新 needConsume', {
                        userKey,
                        onlineCount,
                        newNeedConsume: existing.needConsume,
                        consumedBy: existing.consumedBy
                    });
                    return writeAndRespond(jsonData, res, { message: '重复 push，已更新 needConsume' });
                }

                // 新条目
                const onlineCount = countOnlineDevices(jsonData, userKey, myRepo);
                const needConsume = syncst === 1 ? Math.max(onlineCount, 1) : 0;

                jsonData[userKey] = {
                    syncst,
                    userAgent,
                    ip: clientIp,
                    lastHeartbeat: now,
                    needConsume,
                    consumedBy: []
                };
                logInfo('PUSH 新条目写入', {
                    userKey,
                    syncst,
                    onlineCount,
                    needConsume
                });
                return writeAndRespond(jsonData, res, { message: 'PUSH ok' });
            }

            // ========== 旧设备（纯 repoKey）：保持原逻辑 ==========
            jsonData[userKey] = {
                syncst,
                ip: clientIp,
                userAgent,
                lastHeartbeat: now
            };
            logInfo('PUSH 旧设备写入', { userKey, syncst });
            return writeAndRespond(jsonData, res, { message: 'PUSH ok (legacy)' });
        });
    } else if (action === 'pull') {
        const mySyncSpace = getSyncSpace(userKey);
        const myDevice = getDevicePrefix(userKey);

        logInfo('PULL 收到请求', { userKey, mySyncSpace, myDevice });

        fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) {
                if (err.code === 'ENOENT') {
                    logInfo('PULL data.json 不存在，返回 syncst=0', { userKey });
                    return res.json({ userKey, syncst: 0, onlineCount: 0 });
                }
                logError('PULL 读取文件错误', { err: err.message });
                return res.status(500).json({ message: 'Failed to read data' });
            }

            let jsonData;
            try {
                jsonData = JSON.parse(data);
            } catch (parseErr) {
                logError('PULL 解析 JSON 错误', { err: parseErr.message });
                return res.status(500).json({ message: 'Failed to parse data' });
            }

            // 更新自己的心跳
            if (jsonData[userKey]) {
                jsonData[userKey].lastHeartbeat = now;
            }

            // ========== 策略1：旧设备（纯 repoKey）==========
            if (mySyncSpace === null) {
                const myData = jsonData[userKey];

                if (myData !== undefined && myData.syncst === 1) {
                    const sameDevice = myData.userAgent === userAgent;
                    if (sameDevice) {
                        logInfo('PULL 策略1：本机 push，不消费', { userKey });
                        return writeAndRespond(jsonData, res, null, { userKey, syncst: 0 });
                    } else {
                        logInfo('PULL 策略1：消费其他设备', { userKey });
                        delete jsonData[userKey];
                        return writeAndRespond(jsonData, res, null, { userKey, syncst: 1 });
                    }
                } else if (myData !== undefined && myData.syncst === 0) {
                    delete jsonData[userKey];
                }

                logInfo('PULL 策略1：无更新', { userKey });
                return writeAndRespond(jsonData, res, null, { userKey, syncst: 0 });
            }

            // ========== 策略2：新设备（deviceId|repoKey）v4.7 核心逻辑 ==========
            let hasSync = false;

            // 第一遍：扫描同空间其他设备的 syncst=1，把自己加入 consumedBy
            for (const [key, entry] of Object.entries(jsonData)) {
                const repo = getSyncSpace(key);
                const device = getDevicePrefix(key);
                if (repo !== mySyncSpace) continue;
                if (device === myDevice) continue;
                if (entry.syncst !== 1) continue;

                hasSync = true;
                if (!entry.consumedBy) entry.consumedBy = [];
                if (!entry.consumedBy.includes(myDevice)) {
                    entry.consumedBy.push(myDevice);
                    logInfo('PULL 消费记录', {
                        srcKey: key,
                        consumer: myDevice,
                        consumedBy: entry.consumedBy,
                        needConsume: entry.needConsume
                    });
                }
                // 已消费数达到 needConsume，清除 syncst
                if (entry.consumedBy.length >= entry.needConsume) {
                    entry.syncst = 0;
                    logInfo('PULL syncst 清除（已满足 needConsume）', {
                        srcKey: key,
                        consumedBy: entry.consumedBy,
                        needConsume: entry.needConsume
                    });
                }
            }

            // 第二遍：超时降级 —— 如果 syncst=1 的条目在线设备不足，降低 needConsume
            for (const [key, entry] of Object.entries(jsonData)) {
                const repo = getSyncSpace(key);
                if (repo !== mySyncSpace) continue;
                if (entry.syncst !== 1) continue;
                if (key === userKey) continue; // 不降级自己

                let onlineCount = 0;
                for (const [k2, e2] of Object.entries(jsonData)) {
                    const r2 = getSyncSpace(k2);
                    if (r2 !== mySyncSpace) continue;
                    if (k2 === key) continue;
                    if (now - (e2.lastHeartbeat || 0) <= ONLINE_TIMEOUT_MS) {
                        onlineCount++;
                    }
                }
                if (onlineCount < entry.needConsume) {
                    const oldNeed = entry.needConsume;
                    entry.needConsume = Math.max(onlineCount, 1);
                    logInfo('PULL 超时降级 needConsume', {
                        srcKey: key,
                        oldNeed,
                        newNeed: entry.needConsume,
                        onlineCount,
                        consumedBy: entry.consumedBy
                    });
                    if (entry.consumedBy && entry.consumedBy.length >= entry.needConsume) {
                        entry.syncst = 0;
                        logInfo('PULL 降级后满足 needConsume，清除 syncst', { srcKey: key });
                    }
                }
            }

            // 第三遍：清理过期条目
            for (const [key, entry] of Object.entries(jsonData)) {
                const repo = getSyncSpace(key);
                if (repo !== mySyncSpace) continue;
                const lastHb = entry.lastHeartbeat || 0;
                if (entry.syncst === 1 && now - lastHb > SYNCST1_CLEANUP_MS) {
                    logInfo('PULL 清理过期 syncst=1 条目', { srcKey: key, ageMs: now - lastHb });
                    delete jsonData[key];
                } else if (entry.syncst === 0 && now - lastHb > SYNCST0_CLEANUP_MS) {
                    logInfo('PULL 清理过期 syncst=0 条目', { srcKey: key, ageMs: now - lastHb });
                    delete jsonData[key];
                }
            }

            // 统计同空间在线设备数
            let onlineCount = 0;
            for (const [key, entry] of Object.entries(jsonData)) {
                const repo = getSyncSpace(key);
                if (repo !== mySyncSpace) continue;
                if (now - (entry.lastHeartbeat || 0) <= ONLINE_TIMEOUT_MS) {
                    onlineCount++;
                }
            }

            const resp = { userKey, syncst: hasSync ? 1 : 0, onlineCount };
            logInfo('PULL 响应', resp);
            return writeAndRespond(jsonData, res, null, resp);
        });
    } else {
        logWarn('未知 action', { action });
        return res.status(400).json({ message: 'Invalid action' });
    }
});

/**
 * 写入 data.json 并返回响应
 */
function writeAndRespond(jsonData, res, msgObj, responsePayload) {
    const filePath = path.join(__dirname, 'data.json');
    fs.writeFile(filePath, JSON.stringify(jsonData, null, 2), 'utf8', (writeErr) => {
        if (writeErr) {
            logError('写 data.json 失败', { err: writeErr.message });
            return res.status(500).json({ message: 'Failed to write data' });
        }
        if (responsePayload !== undefined) {
            return res.json(responsePayload);
        }
        return res.json(msgObj || { message: 'ok' });
    });
}

// GET 健康检查
app.get('/', (req, res) => {
    res.status(200).send('感知节点正常运行中');
});

// 调试接口：查看当前 data.json 与最近日志
app.get('/debug', (req, res) => {
    const filePath = path.join(__dirname, 'data.json');
    fs.readFile(filePath, 'utf8', (err, data) => {
        const jsonData = err ? {} : (() => { try { return JSON.parse(data); } catch { return {}; } })();
        // 读最近 50 行日志
        fs.readFile(LOG_FILE, 'utf8', (logErr, logData) => {
            const lines = logErr ? [] : logData.split('\n').slice(-50);
            res.json({
                data: jsonData,
                recentLogs: lines,
                now: Date.now()
            });
        });
    });
});

app.listen(PORT, () => {
    logInfo(`Server is running on port ${PORT}`, { logFile: LOG_FILE });
});
