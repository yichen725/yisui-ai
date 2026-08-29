/**
 * 逸碎 AI 后端服务
 * 功能：
 *   1. POST /v1/chat/completions - 统一聊天代理，根据 model 自动路由到对应 API（隐藏所有 API Key，支持流式）
 *   2. GET /models - 获取可用模型列表（仅返回已配置 API Key 的模型）
 *   3. POST /verify - 卡密验证接口
 *   4. GET /health - 健康检查
 */
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const app = express();
const PORT = process.env.PORT || 3000;

const CARDS_FILE = path.join(__dirname, 'cards.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const CHATS_FILE = path.join(__dirname, 'chats.json');
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'deepseek-v4-pro';

// 中间件
app.use(cors()); // 允许所有来源
app.use(express.json({ limit: '10mb' }));
// 静态文件服务（前端页面）
app.use(express.static(path.join(__dirname, 'public')));

// ============ 模型配置（后端统一管理，前端不可见） ============
/**
 * 每个模型对应：
 *   apiUrl    - 目标 API 地址
 *   apiKeyEnv - 读取哪个环境变量作为 API Key
 *   name      - 前端显示名称
 *   provider  - 服务商标识
 */
const MODEL_CONFIG = {
  // DeepSeek 系列
  // DeepSeek V4 系列
  'deepseek-v4-flash': {
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKeyEnv: 'DEEPSEEK_KEY',
    name: 'DeepSeek V4 Flash（极速）',
    provider: 'deepseek'
  },
  'deepseek-v4-pro': {
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKeyEnv: 'DEEPSEEK_KEY',
    name: 'DeepSeek V4 Pro（旗舰）',
    provider: 'deepseek'
  },
  'deepseek-v4-flash-vision-exp': {
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKeyEnv: 'DEEPSEEK_KEY',
    name: 'DeepSeek V4 Flash Vision（视觉识别）',
    provider: 'deepseek'
  },
  // DeepSeek V3 / R1 系列
  'deepseek-chat': {
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKeyEnv: 'DEEPSEEK_KEY',
    name: 'DeepSeek V3（通用）',
    provider: 'deepseek'
  },
  'deepseek-reasoner': {
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKeyEnv: 'DEEPSEEK_KEY',
    name: 'DeepSeek R1（推理）',
    provider: 'deepseek'
  },
  // OpenAI 系列
  'gpt-4o': {
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    apiKeyEnv: 'OPENAI_KEY',
    name: 'GPT-4o',
    provider: 'openai'
  },
  'gpt-4o-mini': {
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    apiKeyEnv: 'OPENAI_KEY',
    name: 'GPT-4o Mini',
    provider: 'openai'
  },
  'gpt-3.5-turbo': {
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    apiKeyEnv: 'OPENAI_KEY',
    name: 'GPT-3.5 Turbo',
    provider: 'openai'
  },
  // 通义千问（DashScope 兼容 OpenAI 格式）
  'qwen-plus': {
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    apiKeyEnv: 'QWEN_KEY',
    name: '通义千问 Qwen-Plus',
    provider: 'qwen'
  },
  'qwen-turbo': {
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    apiKeyEnv: 'QWEN_KEY',
    name: '通义千问 Qwen-Turbo',
    provider: 'qwen'
  }
};

/**
 * 获取指定模型的 API Key（带兼容回退）
 * 兼容逻辑：如果 DEEPSEEK_KEY 未配置，回退到 OPENAI_KEY（因为用户可能把 DeepSeek Key 存在 OPENAI_KEY 里）
 */
// 检测消息中是否包含图片
function hasImageInMessages(messages) {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item.type === 'image_url' || item.type === 'image') {
          return true;
        }
      }
    }
  }
  return false;
}

function getModelApiKey(modelConfig) {
  const key = process.env[modelConfig.apiKeyEnv];
  if (key) return key;
  // 兼容回退：DeepSeek 未配置时，尝试用 OPENAI_KEY
  if (modelConfig.provider === 'deepseek' && process.env.OPENAI_KEY) {
    return process.env.OPENAI_KEY;
  }
  return null;
}

/**
 * 获取已配置 API Key 的可用模型列表
 */
function getAvailableModels() {
  const available = [];
  for (const [modelId, config] of Object.entries(MODEL_CONFIG)) {
    const apiKey = getModelApiKey(config);
    if (apiKey) {
      available.push({
        id: modelId,
        name: config.name,
        provider: config.provider
      });
    }
  }
  return available;
}

// ============ 工具函数 ============
function readCards() {
  try {
    if (!fs.existsSync(CARDS_FILE)) return [];
    const data = fs.readFileSync(CARDS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    console.error('读取卡密文件失败:', e.message);
    return [];
  }
}

function writeCards(cards) {
  try {
    fs.writeFileSync(CARDS_FILE, JSON.stringify(cards, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('写入卡密文件失败:', e.message);
    return false;
  }
}

// ============ 用户系统工具函数 ============
function readUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    const data = fs.readFileSync(USERS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    console.error('读取用户文件失败:', e.message);
    return [];
  }
}

function writeUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('写入用户文件失败:', e.message);
    return false;
  }
}

// 简单的密码哈希（生产环境建议用 bcrypt）
function hashPassword(password) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(password + 'yisui_salt').digest('hex');
}

// 生成用户 token
function generateUserToken(userId) {
  const crypto = require('crypto');
  return crypto.createHash('md5').update(userId + Date.now() + Math.random()).digest('hex');
}

// ============ 聊天记录工具函数 ============
function readChats() {
  try {
    if (!fs.existsSync(CHATS_FILE)) return [];
    const data = fs.readFileSync(CHATS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    console.error('读取聊天记录文件失败:', e.message);
    return [];
  }
}

function writeChats(chats) {
  try {
    fs.writeFileSync(CHATS_FILE, JSON.stringify(chats, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('写入聊天记录文件失败:', e.message);
    return false;
  }
}

// 保存单条聊天消息
function saveChatMessage(userId, role, content, model) {
  try {
    const chats = readChats();
    const message = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
      userId: userId || 'anonymous',
      role: role,
      content: content,
      model: model || '',
      timestamp: new Date().toISOString()
    };
    chats.push(message);
    // 只保留最近10000条记录，避免文件过大
    if (chats.length > 10000) {
      chats.splice(0, chats.length - 10000);
    }
    writeChats(chats);
    return message;
  } catch (e) {
    console.error('保存聊天记录失败:', e.message);
    return null;
  }
}

// ============ 接口 1：获取可用模型列表 ============
/**
 * GET /models
 * 返回已配置 API Key 的模型列表，前端据此渲染模型选择器
 */
app.get('/models', (req, res) => {
  const models = getAvailableModels();
  res.json({ models });
});

// ============ 接口 2：卡密验证 ============
app.post('/verify', (req, res) => {
  try {
    const { key } = req.body;
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ success: false, message: '请提供卡密' });
    }
    const cards = readCards();
    const card = cards.find(c => c.key === key.trim());
    if (!card) {
      return res.json({ success: false, message: '卡密无效，请检查后重试' });
    }
    if (card.used) {
      return res.json({ success: false, message: '该卡密已被使用' });
    }
    card.used = true;
    card.usedAt = new Date().toISOString();
    writeCards(cards);
    return res.json({ success: true, message: '验证成功，欢迎使用逸碎 AI！' });
  } catch (error) {
    console.error('卡密验证出错:', error);
    return res.status(500).json({ success: false, message: '服务器错误：' + error.message });
  }
});

// ============ 验证码存储（内存，5分钟有效） ============
const verificationCodes = new Map(); // phone/email -> { code, expireAt }

// ============ 邮箱服务配置（QQ邮箱SMTP） ============
// 在 Railway 环境变量中配置以下变量即可启用真实邮件服务：
//   EMAIL_SMTP_HOST     - SMTP服务器地址（如 smtp.qq.com）
//   EMAIL_SMTP_PORT     - SMTP端口（如 465）
//   EMAIL_USER          - 发件邮箱地址
//   EMAIL_PASS          - 邮箱SMTP授权码（不是邮箱密码）
//   EMAIL_FROM_NAME     - 发件人名称（如"逸碎AI"）
const EMAIL_CONFIG = {
  host: process.env.EMAIL_SMTP_HOST || 'smtp.qq.com',
  port: parseInt(process.env.EMAIL_SMTP_PORT) || 587,
  secure: false, // 587端口用STARTTLS
  user: process.env.EMAIL_USER || '',
  pass: process.env.EMAIL_PASS || '',
  fromName: process.env.EMAIL_FROM_NAME || '逸碎AI'
};

// 检查是否配置了邮箱服务
function isEmailConfigured() {
  return !!(EMAIL_CONFIG.user && EMAIL_CONFIG.pass);
}

// 创建邮件传输器
let emailTransporter = null;
function getEmailTransporter() {
  if (!emailTransporter && isEmailConfigured()) {
    emailTransporter = nodemailer.createTransport({
      host: EMAIL_CONFIG.host,
      port: EMAIL_CONFIG.port,
      secure: EMAIL_CONFIG.secure,
      auth: {
        user: EMAIL_CONFIG.user,
        pass: EMAIL_CONFIG.pass
      }
    });
  }
  return emailTransporter;
}

// 发送邮件验证码
async function sendEmailCode(email, code) {
  if (!isEmailConfigured()) {
    console.log('[邮件] 未配置邮箱服务，使用模拟模式');
    return { success: true, mock: true, code: code };
  }
  try {
    console.log('[邮件] 开始发送验证码到:', email);
    const transporter = getEmailTransporter();
    // 设置超时
    transporter.set('timeout', 30000);
    transporter.set('connectionTimeout', 30000);
    transporter.set('greetingTimeout', 30000);
    const mailOptions = {
      from: `"${EMAIL_CONFIG.fromName}" <${EMAIL_CONFIG.user}>`,
      to: email,
      subject: `【${EMAIL_CONFIG.fromName}】注册验证码`,
      text: `您的验证码是：${code}，5分钟内有效，请勿泄露给他人。`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
            <h2 style="color: white; margin: 0; font-size: 24px;">逸碎AI</h2>
            <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">注册验证码</p>
          </div>
          <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 12px 12px;">
            <p style="color: #333; font-size: 16px; margin-bottom: 20px;">您好！</p>
            <p style="color: #666; font-size: 14px; margin-bottom: 20px;">您正在注册逸碎AI账号，验证码如下：</p>
            <div style="background: white; border: 2px solid #667eea; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 20px;">
              <span style="font-size: 32px; font-weight: bold; color: #667eea; letter-spacing: 8px;">${code}</span>
            </div>
            <p style="color: #999; font-size: 12px; margin: 0;">验证码5分钟内有效，请勿泄露给他人。如非本人操作，请忽略此邮件。</p>
          </div>
        </div>
      `
    };
    const result = await transporter.sendMail(mailOptions);
    console.log(`[邮件] 验证码已发送到 ${email}, 消息ID:`, result.messageId);
    return { success: true };
  } catch (error) {
    console.error('[邮件] 发送异常:', error.message);
    console.error('[邮件] 错误详情:', error.stack);
    return { success: false, message: error.message };
  }
}

// ============ 阿里云短信服务配置 ============
// 在 Railway 环境变量中配置以下变量即可启用真实短信服务：
//   ALIYUN_SMS_ACCESS_KEY_ID     - AccessKey ID
//   ALIYUN_SMS_ACCESS_KEY_SECRET - AccessKey Secret
//   ALIYUN_SMS_SIGN_NAME         - 短信签名（如"逸碎AI"）
//   ALIYUN_SMS_TEMPLATE_CODE     - 短信模板ID（如"SMS_123456789"）
const ALIYUN_SMS_CONFIG = {
  accessKeyId: process.env.ALIYUN_SMS_ACCESS_KEY_ID || '',
  accessKeySecret: process.env.ALIYUN_SMS_ACCESS_KEY_SECRET || '',
  signName: process.env.ALIYUN_SMS_SIGN_NAME || '',
  templateCode: process.env.ALIYUN_SMS_TEMPLATE_CODE || ''
};

// 检查是否配置了阿里云短信服务
function isAliyunSmsConfigured() {
  return !!(ALIYUN_SMS_CONFIG.accessKeyId &&
            ALIYUN_SMS_CONFIG.accessKeySecret &&
            ALIYUN_SMS_CONFIG.signName &&
            ALIYUN_SMS_CONFIG.templateCode);
}

// 阿里云短信 API 签名（HMAC-SHA1）
function generateAliyunSignature(params, accessKeySecret) {
  const crypto = require('crypto');
  const sortedParams = Object.keys(params).sort().map(key => {
    return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
  }).join('&');
  const stringToSign = 'GET&%2F&' + encodeURIComponent(sortedParams);
  const signature = crypto.createHmac('sha1', accessKeySecret + '&').update(stringToSign).digest('base64');
  return encodeURIComponent(signature);
}

// 发送短信验证码
async function sendSmsCode(phone, code) {
  if (!isAliyunSmsConfigured()) {
    console.log('[短信] 未配置阿里云短信服务，使用模拟模式');
    return { success: true, mock: true, code: code };
  }
  try {
    const crypto = require('crypto');
    const timestamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const params = {
      Action: 'SendSms',
      Version: '2017-05-25',
      Format: 'JSON',
      AccessKeyId: ALIYUN_SMS_CONFIG.accessKeyId,
      SignatureMethod: 'HMAC-SHA1',
      SignatureVersion: '1.0',
      SignatureNonce: crypto.randomBytes(8).toString('hex'),
      Timestamp: timestamp,
      PhoneNumbers: phone,
      SignName: ALIYUN_SMS_CONFIG.signName,
      TemplateCode: ALIYUN_SMS_CONFIG.templateCode,
      TemplateParam: JSON.stringify({ code: code })
    };
    const signature = generateAliyunSignature(params, ALIYUN_SMS_CONFIG.accessKeySecret);
    const queryString = Object.keys(params).sort().map(key => {
      return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
    }).join('&');
    const url = `https://dysmsapi.aliyuncs.com/?${queryString}&Signature=${signature}`;
    const response = await fetch(url, { method: 'GET' });
    const data = await response.json();
    if (data.Code === 'OK') {
      console.log(`[短信] 验证码已发送到 ${phone}`);
      return { success: true };
    } else {
      console.error('[短信] 发送失败:', data.Message);
      return { success: false, message: data.Message };
    }
  } catch (error) {
    console.error('[短信] 发送异常:', error.message);
    return { success: false, message: error.message };
  }
}

// ============ 接口 2.4：发送验证码（支持手机号和邮箱） ============
app.post('/api/user/send-code', async (req, res) => {
  try {
    const { phone, email } = req.body;
    const contact = phone || email;
    
    if (!contact) {
      return res.status(400).json({ success: false, message: '请输入手机号或邮箱' });
    }
    
    // 判断是手机号还是邮箱
    const isPhone = !!phone;
    const isEmail = !!email && !phone;
    
    // 格式验证
    if (isPhone) {
      const phoneRegex = /^1[3-9]\d{9}$/;
      if (!phoneRegex.test(phone)) {
        return res.status(400).json({ success: false, message: '请输入正确的手机号格式' });
      }
    }
    
    if (isEmail) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ success: false, message: '请输入正确的邮箱格式' });
      }
    }
    
    // 检查是否频繁发送（60秒内只能发一次）
    const existing = verificationCodes.get(contact);
    if (existing && Date.now() < existing.expireAt - 4 * 60 * 1000) {
      return res.status(429).json({ success: false, message: '发送过于频繁，请稍后再试' });
    }
    
    // 生成6位数字验证码
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expireAt = Date.now() + 5 * 60 * 1000; // 5分钟有效
    verificationCodes.set(contact, { code, expireAt });
    console.log(`[验证码] ${isPhone ? '手机号' : '邮箱'}: ${contact}, 验证码: ${code}`);
    
    // 发送验证码
    let sendResult;
    if (isPhone) {
      sendResult = await sendSmsCode(phone, code);
    } else {
      sendResult = await sendEmailCode(email, code);
    }
    
    if (sendResult.success) {
      const response = {
        success: true,
        message: `验证码已发送到${isPhone ? '手机' : '邮箱'}，5分钟内有效`,
        expireIn: 300,
        type: isPhone ? 'phone' : 'email'
      };
      // 模拟模式下返回验证码（用于测试），真实模式下不返回
      if (sendResult.mock) {
        response.code = code;
        response.mock = true;
      }
      return res.json(response);
    } else {
      return res.status(500).json({ success: false, message: '验证码发送失败：' + (sendResult.message || '未知错误') });
    }
  } catch (error) {
    console.error('发送验证码出错:', error);
    return res.status(500).json({ success: false, message: '服务器错误：' + error.message });
  }
});

// ============ 接口 2.5：用户注册（仅用户名和密码，免费注册） ============
app.post('/api/user/register', (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
    }
    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ success: false, message: '用户名长度需在3-20个字符之间' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: '密码长度不能少于6位' });
    }
    
    const users = readUsers();
    if (users.find(u => u.username === username)) {
      return res.status(400).json({ success: false, message: '用户名已存在' });
    }
    
    const userId = 'user_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const token = generateUserToken(userId);
    const newUser = {
      id: userId,
      username: username,
      password: hashPassword(password),
      phone: '',
      email: '',
      token: token,
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
      status: 'active'
    };
    users.push(newUser);
    writeUsers(users);
    
    return res.json({
      success: true,
      message: '注册成功',
      data: {
        userId: userId,
        username: username,
        token: token
      }
    });
  } catch (error) {
    console.error('用户注册出错:', error);
    return res.status(500).json({ success: false, message: '服务器错误：' + error.message });
  }
});

// ============ 接口 2.6：用户登录 ============
app.post('/api/user/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
    }
    const users = readUsers();
    const user = users.find(u => u.username === username);
    if (!user) {
      return res.status(401).json({ success: false, message: '用户名或密码错误' });
    }
    if (user.password !== hashPassword(password)) {
      return res.status(401).json({ success: false, message: '用户名或密码错误' });
    }
    if (user.status === 'banned') {
      return res.status(403).json({ success: false, message: '账号已被封禁' });
    }
    const token = generateUserToken(user.id);
    user.token = token;
    user.lastLoginAt = new Date().toISOString();
    writeUsers(users);
    return res.json({
      success: true,
      message: '登录成功',
      data: {
        userId: user.id,
        username: user.username,
        token: token
      }
    });
  } catch (error) {
    console.error('用户登录出错:', error);
    return res.status(500).json({ success: false, message: '服务器错误：' + error.message });
  }
});

// ============ 接口 2.7：获取用户信息 ============
app.get('/api/user/info', (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (!token) {
      return res.status(401).json({ success: false, message: '未登录' });
    }
    const users = readUsers();
    const user = users.find(u => u.token === token);
    if (!user) {
      return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
    }
    return res.json({
      success: true,
      data: {
        userId: user.id,
        username: user.username,
        email: user.email,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt
      }
    });
  } catch (error) {
    console.error('获取用户信息出错:', error);
    return res.status(500).json({ success: false, message: '服务器错误：' + error.message });
  }
});

// ============ 接口 3：统一聊天代理（根据 model 自动路由） ============
/**
 * POST /v1/chat/completions
 * 请求体（兼容 OpenAI 格式）：
 *   {
 *     "model": "deepseek-chat",       // 模型 ID，必须是 /models 返回的可用模型
 *     "messages": [{ "role": "user", "content": "你好" }],
 *     "temperature": 0.7,
 *     "max_tokens": 4096,
 *     "stream": true
 *   }
 *
 * 注意：前端不再传 apiUrl、apiKey，全部由后端根据 model 自动匹配
 */
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { messages, temperature, max_tokens, stream } = req.body;
    // 获取用户信息（用于聊天记录存储）
    const userToken = req.headers.authorization?.replace('Bearer ', '') || req.body.userToken || '';
    let userId = 'anonymous';
    if (userToken) {
      const users = readUsers();
      const user = users.find(u => u.token === userToken);
      if (user) userId = user.id;
    }
    // 保存用户消息
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    if (lastUserMsg) {
      let userContent = lastUserMsg.content;
      if (Array.isArray(userContent)) {
        userContent = userContent.map(item => item.type === 'text' ? item.text : '[图片]').join(' ');
      }
      saveChatMessage(userId, 'user', String(userContent), req.body.model || '');
    }
    // 自动模型路由：有图片用 Vision 版，无图用 Pro 版
    let model = req.body.model || DEFAULT_MODEL;
    if (hasImageInMessages(messages)) {
      model = 'deepseek-v4-flash-vision-exp';
      console.log('检测到图片，自动切换到 Vision 模型');
    } else if (!MODEL_CONFIG[model]) {
      model = DEFAULT_MODEL;
    }

    if (!model || !Array.isArray(messages)) {
      return res.status(400).json({ error: { message: '缺少必要参数：model 和 messages' } });
    }

    // 根据 model 查找配置
    const modelConfig = MODEL_CONFIG[model];
    if (!modelConfig) {
      return res.status(400).json({
        error: { message: `不支持的模型：${model}，请调用 /models 获取可用列表` }
      });
    }

    // 从环境变量读取对应 API Key
    const apiKey = getModelApiKey(modelConfig);
    if (!apiKey) {
      return res.status(500).json({
        error: { message: `模型 ${model} 未配置 API Key，请在后端环境变量中添加 ${modelConfig.apiKeyEnv}` }
      });
    }

    // 构建转发请求体（移除前端可能传入的 apiUrl 等敏感覆盖字段）
    const requestBody = {
      model,
      messages,
      temperature: typeof temperature === 'number' ? temperature : 0.7,
      max_tokens: typeof max_tokens === 'number' ? max_tokens : 4096,
      stream: stream !== false
    };

    // 发起转发请求
    const response = await fetch(modelConfig.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).send(errText);
    }

    // 流式响应转发
    if (stream !== false) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullResponse = ''; // 收集完整回复用于保存
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
        // 解析流式数据，收集回复内容
        const lines = chunk.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
            try {
              const json = JSON.parse(trimmed.slice(6));
              const content = json.choices?.[0]?.delta?.content;
              if (content) fullResponse += content;
            } catch (e) {}
          }
        }
      }
      res.end();
      // 保存 AI 回复
      if (fullResponse) {
        saveChatMessage(userId, 'assistant', fullResponse, model);
      }
    } else {
      const data = await response.json();
      res.json(data);
      // 保存 AI 回复
      const assistantContent = data.choices?.[0]?.message?.content;
      if (assistantContent) {
        saveChatMessage(userId, 'assistant', String(assistantContent), model);
      }
    }
  } catch (error) {
    console.error('聊天代理出错:', error);
    return res.status(500).json({ error: { message: '代理服务器错误：' + error.message } });
  }
});

// ============ 接口 4：健康检查 ============
app.get('/health', (req, res) => {
  const availableModels = getAvailableModels();
  const cards = readCards();
  const totalCards = cards.length;
  const usedCards = cards.filter(c => c.used).length;

  // 统计各服务商 Key 配置状态
  const providers = {};
  for (const config of Object.values(MODEL_CONFIG)) {
    if (!providers[config.provider]) {
      providers[config.provider] = {
        configured: !!getModelApiKey(config),
        envVar: config.apiKeyEnv
      };
    }
  }

  res.json({
    status: 'ok',
    availableModels: availableModels.length,
    models: availableModels,
    providers,
    totalCards,
    usedCards,
    availableCards: totalCards - usedCards
  });
});

// ============ 管理员后台 API ============
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_TOKENS = new Map(); // token -> expireTime

// 生成简单 token
function generateToken() {
  const token = Buffer.from(Date.now() + '_' + Math.random()).toString('base64').replace(/=/g, '');
  ADMIN_TOKENS.set(token, Date.now() + 12 * 60 * 60 * 1000); // 12小时有效
  return token;
}

// 验证 token 中间件
function authAdmin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token || !ADMIN_TOKENS.has(token)) {
    return res.status(401).json({ success: false, message: '未登录或登录已过期' });
  }
  const expireTime = ADMIN_TOKENS.get(token);
  if (Date.now() > expireTime) {
    ADMIN_TOKENS.delete(token);
    return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
  }
  next();
}

// 管理员登录
app.post('/api/admin/login', (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ success: false, message: '请输入密码' });
    }
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, message: '密码错误' });
    }
    const token = generateToken();
    res.json({ success: true, token, message: '登录成功' });
  } catch (error) {
    res.status(500).json({ success: false, message: '服务器错误：' + error.message });
  }
});

// 获取统计数据
app.get('/api/admin/stats', authAdmin, (req, res) => {
  try {
    const cards = readCards();
    const totalCards = cards.length;
    const usedCards = cards.filter(c => c.used).length;
    const availableModels = getAvailableModels();
    const providers = {};
    for (const config of Object.values(MODEL_CONFIG)) {
      if (!providers[config.provider]) {
        providers[config.provider] = {
          configured: !!getModelApiKey(config),
          envVar: config.apiKeyEnv
        };
      }
    }
    res.json({
      success: true,
      data: {
        totalCards,
        usedCards,
        availableCards: totalCards - usedCards,
        totalModels: Object.keys(MODEL_CONFIG).length,
        availableModels: availableModels.length,
        models: availableModels,
        providers,
        version: '1.1.0',
        uptime: process.uptime()
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: '服务器错误：' + error.message });
  }
});

// 获取所有卡密
app.get('/api/admin/cards', authAdmin, (req, res) => {
  try {
    const cards = readCards();
    // 按创建时间倒序
    const sorted = cards.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });
    res.json({ success: true, data: sorted });
  } catch (error) {
    res.status(500).json({ success: false, message: '服务器错误：' + error.message });
  }
});

// 生成卡密（支持批量）
app.post('/api/admin/cards', authAdmin, (req, res) => {
  try {
    const { count = 1, prefix = 'YS' } = req.body;
    const num = Math.min(parseInt(count) || 1, 100); // 最多一次生成100个
    const cards = readCards();
    const newCards = [];
    for (let i = 0; i < num; i++) {
      const key = prefix + '-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();
      const card = {
        key,
        used: false,
        createdAt: new Date().toISOString()
      };
      cards.push(card);
      newCards.push(card);
    }
    writeCards(cards);
    res.json({ success: true, message: `成功生成 ${num} 个卡密`, data: newCards });
  } catch (error) {
    res.status(500).json({ success: false, message: '服务器错误：' + error.message });
  }
});

// 删除卡密
app.delete('/api/admin/cards/:key', authAdmin, (req, res) => {
  try {
    const { key } = req.params;
    const cards = readCards();
    const index = cards.findIndex(c => c.key === key);
    if (index === -1) {
      return res.status(404).json({ success: false, message: '卡密不存在' });
    }
    cards.splice(index, 1);
    writeCards(cards);
    res.json({ success: true, message: '卡密已删除' });
  } catch (error) {
    res.status(500).json({ success: false, message: '服务器错误：' + error.message });
  }
});

// 清空已使用的卡密
app.post('/api/admin/cards/clean', authAdmin, (req, res) => {
  try {
    const cards = readCards();
    const beforeCount = cards.length;
    const remaining = cards.filter(c => !c.used);
    const deleted = beforeCount - remaining.length;
    writeCards(remaining);
    res.json({ success: true, message: `已清理 ${deleted} 个已使用的卡密`, remaining: remaining.length });
  } catch (error) {
    res.status(500).json({ success: false, message: '服务器错误：' + error.message });
  }
});

// ============ 管理员：用户管理 ============
// 获取用户列表
app.get('/api/admin/users', authAdmin, (req, res) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;
    let users = readUsers();
    // 搜索过滤
    if (search) {
      const keyword = search.toLowerCase();
      users = users.filter(u =>
        u.username.toLowerCase().includes(keyword) ||
        u.id.toLowerCase().includes(keyword) ||
        (u.email && u.email.toLowerCase().includes(keyword))
      );
    }
    // 分页
    const total = users.length;
    const start = (parseInt(page) - 1) * parseInt(limit);
    const paginatedUsers = users.slice(start, start + parseInt(limit));
    // 返回时不包含密码
    const safeUsers = paginatedUsers.map(u => ({
      id: u.id,
      username: u.username,
      email: u.email,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
      status: u.status
    }));
    res.json({
      success: true,
      data: {
        users: safeUsers,
        total: total,
        page: parseInt(page),
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: '服务器错误：' + error.message });
  }
});

// 获取用户详情
app.get('/api/admin/users/:id', authAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const users = readUsers();
    const user = users.find(u => u.id === id);
    if (!user) {
      return res.status(404).json({ success: false, message: '用户不存在' });
    }
    // 统计用户聊天记录数
    const chats = readChats();
    const userChats = chats.filter(c => c.userId === id);
    res.json({
      success: true,
      data: {
        id: user.id,
        username: user.username,
        email: user.email,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        status: user.status,
        chatCount: userChats.length
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: '服务器错误：' + error.message });
  }
});

// 封禁/解封用户
app.post('/api/admin/users/:id/ban', authAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const { banned } = req.body;
    const users = readUsers();
    const user = users.find(u => u.id === id);
    if (!user) {
      return res.status(404).json({ success: false, message: '用户不存在' });
    }
    user.status = banned ? 'banned' : 'active';
    writeUsers(users);
    res.json({ success: true, message: banned ? '用户已封禁' : '用户已解封' });
  } catch (error) {
    res.status(500).json({ success: false, message: '服务器错误：' + error.message });
  }
});

// ============ 管理员：聊天记录 ============
// 获取聊天记录
app.get('/api/admin/chats', authAdmin, (req, res) => {
  try {
    const { userId, search, page = 1, limit = 50 } = req.query;
    let chats = readChats();
    // 按用户过滤
    if (userId) {
      chats = chats.filter(c => c.userId === userId);
    }
    // 搜索过滤
    if (search) {
      const keyword = search.toLowerCase();
      chats = chats.filter(c => c.content.toLowerCase().includes(keyword));
    }
    // 按时间倒序
    chats.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    // 分页
    const total = chats.length;
    const start = (parseInt(page) - 1) * parseInt(limit);
    const paginatedChats = chats.slice(start, start + parseInt(limit));
    // 关联用户名
    const users = readUsers();
    const userMap = {};
    users.forEach(u => { userMap[u.id] = u.username; });
    const result = paginatedChats.map(c => ({
      id: c.id,
      userId: c.userId,
      username: userMap[c.userId] || (c.userId === 'anonymous' ? '匿名用户' : c.userId),
      role: c.role,
      content: c.content,
      model: c.model,
      timestamp: c.timestamp
    }));
    res.json({
      success: true,
      data: {
        chats: result,
        total: total,
        page: parseInt(page),
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: '服务器错误：' + error.message });
  }
});

// 删除聊天记录
app.delete('/api/admin/chats/:id', authAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const chats = readChats();
    const index = chats.findIndex(c => c.id === id);
    if (index === -1) {
      return res.status(404).json({ success: false, message: '聊天记录不存在' });
    }
    chats.splice(index, 1);
    writeChats(chats);
    res.json({ success: true, message: '聊天记录已删除' });
  } catch (error) {
    res.status(500).json({ success: false, message: '服务器错误：' + error.message });
  }
});

// ============ 启动服务 ============
app.listen(PORT, () => {
  const availableModels = getAvailableModels();
  console.log('========================================');
  console.log('  逸碎 AI 后端服务已启动（模型后端统一管理）');
  console.log('  端口:', PORT);
  console.log('  聊天接口: POST /v1/chat/completions');
  console.log('  模型列表: GET /models');
  console.log('  卡密验证: POST /verify');
  console.log('  健康检查: GET /health');
  console.log('  可用模型数量:', availableModels.length);
  availableModels.forEach(m => {
    console.log('    -', m.id, '(' + m.name + ')');
  });
  console.log('========================================');
});
