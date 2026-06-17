const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 7777;

app.use(cors());
// 使用 body-parser 中间件解析 JSON 请求体
app.use(bodyParser.json());

// 辅助函数：从 userKey 中提取同步空间 hash（|后面的部分）
function getSyncSpace(userKey) {
  const pipeIndex = userKey.indexOf('|');
  if (pipeIndex === -1) return null;
  return userKey.substring(pipeIndex + 1);
}

// 辅助函数：从 userKey 中提取设备前缀（|前面的部分）
function getDevicePrefix(userKey) {
  const pipeIndex = userKey.indexOf('|');
  if (pipeIndex === -1) return userKey;
  return userKey.substring(0, pipeIndex);
}

app.post('/', (req, res) => {
  const userKey = decodeURIComponent(req.headers['userkey']); // 解码 userKey
  const action = req.headers['action']; // 获取 action
  const requestBody = req.body;
  const clientIp = (req.headers['x-forwarded-for'] || '').split(',').pop().trim();
  const userAgent = req.headers['user-agent']; // 获取 User-Agent

  console.log('========== 收到请求 ==========');
  console.log('时间:', new Date().toISOString());
  console.log('Action:', action);
  console.log('UserKey:', userKey);
  console.log('Request Body:', JSON.stringify(requestBody));
  console.log('Client IP:', clientIp);
  console.log('User-Agent:', userAgent);
  console.log('Headers:', JSON.stringify(req.headers));
  console.log('================================');

  const filePath = path.join(__dirname, 'data.json');

  if (action === 'push') {
    console.log('[PUSH] 收到push请求');
    console.log('[PUSH] requestBody:', requestBody);
    console.log('[PUSH] requestBody.syncst:', requestBody.syncst);
    
    // 将 userKey、syncst、IP 和 User-Agent 以键对值的形式写入 JSON 文件
    const dataToWrite = {
      [userKey]: {
        syncst: requestBody.syncst,
        ip: clientIp,
        userAgent: userAgent
      }
    };
    console.log('[PUSH] 准备写入的数据:', JSON.stringify(dataToWrite, null, 2));

    // 读取现有的 JSON 文件内容
    fs.readFile(filePath, 'utf8', (err, data) => {
      let jsonData = {};
      if (!err && data) {
        try {
          jsonData = JSON.parse(data);
          console.log('[PUSH] 读取到现有数据:', JSON.stringify(jsonData, null, 2));
        } catch (parseErr) {
          console.error('[PUSH] 解析JSON错误:', parseErr);
        }
      } else if (err) {
        console.log('[PUSH] 读取文件错误或文件为空:', err ? err.message : '空文件');
      }

      // 更新 JSON 数据
      jsonData = { ...jsonData, ...dataToWrite };
      console.log('[PUSH] 合并后的数据:', JSON.stringify(jsonData, null, 2));

      // 写入更新后的 JSON 数据
      fs.writeFile(filePath, JSON.stringify(jsonData, null, 2), 'utf8', (writeErr) => {
        if (writeErr) {
          console.error('[PUSH] 写入文件错误:', writeErr);
          return res.status(500).json({ message: 'Failed to write data' });
        }
        console.log('[PUSH] 数据写入成功!');

        // 发送响应
        res.json({ message: 'Data received and written successfully' });
      });
    });
  } else if (action === 'pull') {
    console.log('[PULL] 收到pull请求');
    console.log('[PULL] 查询的userKey:', userKey);
    console.log('[PULL] 客户端IP:', clientIp);

    const mySyncSpace = getSyncSpace(userKey);
    const myDevice = getDevicePrefix(userKey);
    console.log('[PULL] 同步空间:', mySyncSpace || '纯key模式', '设备:', myDevice);

    // 读取现有的 JSON 文件内容
    fs.readFile(filePath, 'utf8', (err, data) => {
      let jsonData = {};
      if (err) {
        if (err.code === 'ENOENT') {
          console.log('[PULL] data.json 不存在，返回 syncst=0');
          return res.json({ userKey, syncst: 0 });
        } else {
          console.error('[PULL] 读取JSON文件错误:', err);
          return res.status(500).json({ message: 'Failed to read data' });
        }
      }

      try {
        jsonData = JSON.parse(data);
      } catch (parseErr) {
        console.error('[PULL] 解析JSON错误:', parseErr);
        return res.status(500).json({ message: 'Failed to parse data' });
      }

      console.log('[PULL] 当前data.json内容:', JSON.stringify(jsonData, null, 2));

      // 策略1：纯 repoKey 模式（新脚本，userKey 不含 |）
      // 两台设备共用同一个 key，通过 userAgent 区分设备，避免自己消费自己
      if (mySyncSpace === null) {
        const myData = jsonData[userKey];

        if (myData !== undefined && myData.syncst === 1) {
          // 判断是否本机 push：本机 push 不会被自己消费
          const sameDevice = myData.userAgent === userAgent;
          if (sameDevice) {
            // 本机 push，不消费
            console.log('[PULL] 纯key模式：本机 push，不消费');
            // 只读不写
            return res.json({ userKey, syncst: 0 });
          } else {
            // 其他设备 push，消费
            console.log('[PULL] 纯key模式：检测到其他设备 push，通知同步');
            delete jsonData[userKey];
            fs.writeFile(filePath, JSON.stringify(jsonData, null, 2), 'utf8', (writeErr) => {
              if (writeErr) {
                console.error('[PULL] 写入文件错误:', writeErr);
                return res.status(500).json({ message: 'Failed to write data' });
              }
              res.json({ userKey, syncst: 1 });
            });
            return;
          }
        } else if (myData !== undefined && myData.syncst === 0) {
          // syncst=0，清理
          delete jsonData[userKey];
        }

        console.log('[PULL] 纯key模式：无新变更，返回 syncst=0');
        fs.writeFile(filePath, JSON.stringify(jsonData, null, 2), 'utf8', (writeErr) => {
          if (writeErr) {
            console.error('[PULL] 写入文件错误:', writeErr);
            return res.status(500).json({ message: 'Failed to write data' });
          }
          res.json({ userKey, syncst: 0 });
        });
        return;
      }

      // 策略2：appId|repoKey 模式（旧脚本，userKey 含 |）
      // 扫描同一同步空间中其他设备的 push 状态

      // 清理自身旧数据（syncst=0 的条目）
      const myData = jsonData[userKey];
      if (myData !== undefined && myData.syncst === 0) {
        delete jsonData[userKey];
        console.log('[PULL] 旧格式：清理自身旧数据');
      }

      // 扫描同一同步空间中其他设备的 push 状态
      let foundOtherDeviceUpdate = false;
      for (const [key, entry] of Object.entries(jsonData)) {
        const otherSyncSpace = getSyncSpace(key);
        const otherDevice = getDevicePrefix(key);

        // 必须是同一同步空间，且是不同设备，且 syncst=1（有新变更）
        if (otherSyncSpace === mySyncSpace && otherDevice !== myDevice && entry.syncst === 1) {
          console.log('[PULL] 旧格式：检测到同空间其他设备变更:', key, 'syncst=1');
          // 标记为已消费
          entry.syncst = 0;
          foundOtherDeviceUpdate = true;
          break; // 只需找到一个即可
        }
      }

      const resultSyncst = foundOtherDeviceUpdate ? 1 : 0;
      console.log('[PULL] 最终返回 syncst:', resultSyncst);

      fs.writeFile(filePath, JSON.stringify(jsonData, null, 2), 'utf8', (writeErr) => {
        if (writeErr) {
          console.error('[PULL] 写入文件错误:', writeErr);
          return res.status(500).json({ message: 'Failed to write data' });
        }
        res.json({ userKey, syncst: resultSyncst });
      });
    });
  } else {
    res.status(400).json({ message: 'Invalid action' });
  }
});

// 新增 GET 请求处理
app.get('/', (req, res) => {
  res.status(200).send('感知节点正常运行中');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
