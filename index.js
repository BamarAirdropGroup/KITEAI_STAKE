require('dotenv').config();
const axios = require('axios');
const { ethers } = require('ethers');
const crypto = require('crypto');
const UserAgent = require('user-agents');
const readline = require('readline').createInterface({
  input: process.stdin,
  output: process.stdout
});
const fs = require('fs').promises;
const { HttpsProxyAgent } = require('https-proxy-agent');

const colors = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  white: '\x1b[37m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
  bold: '\x1b[1m'
};

const logger = {
  info: (msg) => console.log(`${colors.green}[✓] ${msg}${colors.reset}`),
  wallet: (msg) => console.log(`${colors.yellow}[➤] ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}[✗] ${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.green}[] ${msg}${colors.reset}`),
  loading: (msg) => console.log(`${colors.cyan}[⟳] ${msg}${colors.reset}`),
  step: (msg) => console.log(`${colors.white}[➤] ${msg}${colors.reset}`),
  banner: () => {
    console.log(`${colors.cyan}${colors.bold}`);
    console.log('---------------------------------------------');
    console.log('     KiteAI Faucet & Stake V2 - Bamar Airdrop Group');
    console.log(`---------------------------------------------${colors.reset}\n`);
  }
};

let proxies = [];
let currentProxyIndex = 0;

const loadProxies = async () => {
  try {
    const content = await fs.readFile('proxy.txt', 'utf8');
    proxies = content.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'))
      .map(line => {
        const parts = line.split(':');
        if (parts.length < 2) return null;
        
        const proxy = {
          host: parts[0],
          port: parseInt(parts[1]),
        };
        
        if (parts.length >= 4) {
          proxy.auth = `${parts[2]}:${parts[3]}`;
        }
        
        return proxy;
      })
      .filter(proxy => proxy !== null);
    
    if (proxies.length === 0) {
      logger.error('No valid proxies found in proxy.txt');
      return [];
    }
    
    logger.success(`Loaded ${proxies.length} proxies from proxy.txt`);
    return proxies;
  } catch (error) {
    logger.error(`Failed to load proxy.txt: ${error.message}`);
    return [];
  }
};

const getNextProxy = () => {
  if (proxies.length === 0) return null;
  currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
  return proxies[currentProxyIndex];
};

const createAxiosInstance = (proxyConfig) => {
  try {
    if (!proxyConfig) {
      return axios.create({ timeout: 30000 });
    }

    let proxyUrl;
    if (proxyConfig.auth) {
      proxyUrl = `http://${proxyConfig.auth}@${proxyConfig.host}:${proxyConfig.port}`;
    } else {
      proxyUrl = `http://${proxyConfig.host}:${proxyConfig.port}`;
    }

    const agent = new HttpsProxyAgent(proxyUrl);
    
    return axios.create({
      httpsAgent: agent,
      timeout: 30000,
      proxy: false
    });
  } catch (error) {
    logger.error(`Failed to create proxy agent: ${error.message}`);
    return axios.create({ timeout: 30000 });
  }
};

const baseHeaders = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  'Origin': 'https://testnet.gokite.ai',
  'Referer': 'https://testnet.gokite.ai/',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  'User-Agent': new UserAgent().toString(),
  'Content-Type': 'application/json'
};

const SUBNETS = {
  1: '0xc368ae279275f80125284d16d292b650ecbbff8d',
  2: '0xca312b44a57cc9fd60f37e6c9a343a1ad92a3b6c',
  3: '0xb132001567650917d6bd695d1fab55db7986e9a5',
  4: '0x56f0505a1d84357164f4a8e11df55be4a25b30e6'
};

const getWallet = (privateKey) => {
  try {
    const wallet = new ethers.Wallet(privateKey);
    logger.info(`Wallet created: ${wallet.address}`);
    return wallet;
  } catch (error) {
    logger.error(`Invalid private key: ${error.message}`);
    return null;
  }
};

const encryptAddress = (address) => {
  try {
    const keyHex = '6a1c35292b7c5b769ff47d89a17e7bc4f0adfe1b462981d28e0e9f7ff20b8f8a';
    const key = Buffer.from(keyHex, 'hex');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(address, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();
    
    const result = Buffer.concat([iv, encrypted, authTag]);
    return result.toString('hex');
  } catch (error) {
    logger.error(`Auth token generation failed for ${address}`);
    return null;
  }
};

const extractCookies = (headers) => {
  try {
    const rawCookies = headers['set-cookie'] || [];
    const skipKeys = ['expires', 'path', 'domain', 'samesite', 'secure', 'httponly', 'max-age'];
    const cookiesDict = {};
    
    for (const cookieStr of rawCookies) {
      const parts = cookieStr.split(';');
      for (const part of parts) {
        const cookie = part.trim();
        if (cookie.includes('=')) {
          const [name, value] = cookie.split('=', 2);
          if (name && value && !skipKeys.includes(name.toLowerCase())) {
            cookiesDict[name] = value;
          }
        }
      }
    }
    
    return Object.entries(cookiesDict).map(([key, value]) => `${key}=${value}`).join('; ') || null;
  } catch (error) {
    return null;
  }
};

const solveRecaptcha = async (url, apiKey, maxRetries = 3) => {
  const siteKey = '6Lc_VwgrAAAAALtx_UtYQnW-cFg8EPDgJ8QVqkaz';
  const proxy = getNextProxy();
  const axiosInstance = createAxiosInstance(proxy);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.loading(`Solving reCAPTCHA with CapMonster (Attempt ${attempt}/${maxRetries})${proxy ? ` [Proxy: ${proxy.host}:${proxy.port}]` : ''}`);
      
      const createTaskResponse = await axiosInstance.post('https://api.capmonster.cloud/createTask', {
        clientKey: apiKey,
        task: {
          type: "NoCaptchaTaskProxyless",
          websiteURL: url,
          websiteKey: siteKey
        }
      });
      
      if (createTaskResponse.data.errorId !== 0) {
        logger.error(`Failed to create task: ${createTaskResponse.data.errorDescription}`);
        if (attempt === maxRetries) return null;
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }
      
      const taskId = createTaskResponse.data.taskId;
      logger.step(`reCAPTCHA task created, ID: ${taskId}`);
      
      let pollAttempts = 0;
      const maxPollAttempts = 30;
      const pollInterval = 5000;
      
      while (pollAttempts < maxPollAttempts) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        const resultResponse = await axiosInstance.post('https://api.capmonster.cloud/getTaskResult', {
          clientKey: apiKey,
          taskId: taskId
        });
        
        if (resultResponse.data.status === "ready") {
          logger.success('reCAPTCHA solved successfully');
          return resultResponse.data.solution.gRecaptchaResponse;
        }
        
        if (resultResponse.data.errorId !== 0) {
          logger.error(`reCAPTCHA solving error: ${resultResponse.data.errorDescription}`);
          if (attempt === maxRetries) return null;
          break;
        }
        
        pollAttempts++;
        logger.step(`Waiting for reCAPTCHA solution (Attempt ${pollAttempts}/${maxPollAttempts})`);
      }
    } catch (error) {
      logger.error(`CapMonster error: ${error.message}`);
      if (attempt === maxRetries) return null;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  
  logger.error('reCAPTCHA solving failed after maximum retries');
  return null;
};

const claimDailyFaucet = async (access_token, cookieHeader) => {
  try {
    let apiKey;
    try {
      const keyContent = await fs.readFile('key.txt', 'utf8');
      apiKey = keyContent.trim();
      if (!apiKey) {
        logger.error('No API key found in key.txt');
        return false;
      }
    } catch (error) {
      logger.error(`Failed to read key.txt: ${error.message}`);
      return false;
    }

    logger.loading('Attempting to claim daily faucet...');
    
    const pageUrl = 'https://testnet.gokite.ai';
    const recaptchaToken = await solveRecaptcha(pageUrl, apiKey);
    
    if (!recaptchaToken) {
      logger.error('Failed to obtain reCAPTCHA token');
      return false;
    }
    
    const faucetHeaders = {
      ...baseHeaders,
      Authorization: `Bearer ${access_token}`,
      'x-recaptcha-token': recaptchaToken
    };
    
    if (cookieHeader) {
      faucetHeaders['Cookie'] = cookieHeader;
    }
    
    const proxy = getNextProxy();
    const axiosInstance = createAxiosInstance(proxy);
    logger.step(`Using proxy: ${proxy ? `${proxy.host}:${proxy.port}` : 'No proxy'}`);
    
    const response = await axiosInstance.post('https://ozone-point-system.prod.gokite.ai/blockchain/faucet-transfer', {}, {
      headers: faucetHeaders
    });
    
    if (response.data.error) {
      logger.error(`Faucet claim failed: ${response.data.error}`);
      return false;
    }
    
    logger.success('Daily faucet claimed successfully');
    return true;
  } catch (error) {
    logger.error(`Faucet claim error: ${error.response?.data?.error || error.message}`);
    return false;
  }
};

const getStakeInfo = async (access_token, cookieHeader) => {
  try {
    logger.loading('Fetching stake information for all subnets...');
    
    const stakeHeaders = {
      ...baseHeaders,
      Authorization: `Bearer ${access_token}`
    };
    
    if (cookieHeader) {
      stakeHeaders['Cookie'] = cookieHeader;
    }
    
    const stakeInfo = {};
    for (const [subnetId, subnetAddress] of Object.entries(SUBNETS)) {
      const proxy = getNextProxy();
      const axiosInstance = createAxiosInstance(proxy);
      logger.step(`Fetching stake info for subnet ${subnetId} using proxy: ${proxy ? `${proxy.host}:${proxy.port}` : 'No proxy'}`);
      
      const response = await axiosInstance.get(`https://ozone-point-system.prod.gokite.ai/subnet/${subnetId}/staked-info?id=${subnetId}`, {
        headers: stakeHeaders
      });
      
      if (response.data.error) {
        logger.error(`Failed to fetch stake info for subnet ${subnetId}: ${response.data.error}`);
        stakeInfo[subnetId] = null;
      } else {
        stakeInfo[subnetId] = response.data.data;
      }
    }
    
    return stakeInfo;
  } catch (error) {
    logger.error(`Stake info fetch error: ${error.response?.data?.error || error.message}`);
    return null;
  }
};

const stakeToken = async (access_token, cookieHeader, maxRetries = 5) => {
  try {
    logger.loading('Attempting to stake 1 KITE token for all subnets...');
    
    const stakeHeaders = {
      ...baseHeaders,
      Authorization: `Bearer ${access_token}`
    };
    
    if (cookieHeader) {
      stakeHeaders['Cookie'] = cookieHeader;
    }
    
    let allSuccessful = true;
    for (const [subnetId, subnetAddress] of Object.entries(SUBNETS)) {
      const payload = {
        subnet_address: subnetAddress,
        amount: 1
      };
      
      let success = false;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const proxy = getNextProxy();
          const axiosInstance = createAxiosInstance(proxy);
          logger.step(`Staking for subnet ${subnetId} using proxy: ${proxy ? `${proxy.host}:${proxy.port}` : 'No proxy'} (Attempt ${attempt}/${maxRetries})`);
          
          const response = await axiosInstance.post('https://ozone-point-system.prod.gokite.ai/subnet/delegate', payload, {
            headers: stakeHeaders
          });
          
          if (response.data.error) {
            logger.error(`Stake failed for subnet ${subnetId}: ${response.data.error}`);
            continue;
          }
          
          logger.success(`Successfully staked 1 KITE token for subnet ${subnetId}`);
          success = true;
          break;
        } catch (error) {
          if (attempt === maxRetries) {
            logger.error(`Stake error for subnet ${subnetId} after ${maxRetries} attempts: ${error.response?.data?.error || error.message}`);
            allSuccessful = false;
          }
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
      if (!success) allSuccessful = false;
    }
    
    return allSuccessful;
  } catch (error) {
    logger.error(`Stake error: ${error.response?.data?.error || error.message}`);
    return false;
  }
};

const claimStakeRewards = async (access_token, cookieHeader, maxRetries = 5) => {
  try {
    logger.loading('Attempting to claim stake rewards for all subnets...');
    
    const claimHeaders = {
      ...baseHeaders,
      Authorization: `Bearer ${access_token}`
    };
    
    if (cookieHeader) {
      claimHeaders['Cookie'] = cookieHeader;
    }
    
    let allSuccessful = true;
    for (const [subnetId, subnetAddress] of Object.entries(SUBNETS)) {
      const payload = {
        subnet_address: subnetAddress
      };
      
      let success = false;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const proxy = getNextProxy();
          const axiosInstance = createAxiosInstance(proxy);
          logger.step(`Claiming rewards for subnet ${subnetId} using proxy: ${proxy ? `${proxy.host}:${proxy.port}` : 'No proxy'} (Attempt ${attempt}/${maxRetries})`);
          
          const response = await axiosInstance.post('https://ozone-point-system.prod.gokite.ai/subnet/claim-rewards', payload, {
            headers: claimHeaders
          });
          
          if (response.data.error) {
            logger.error(`Claim rewards failed for subnet ${subnetId}: ${response.data.error}`);
            continue;
          }
          
          const reward = response.data.data?.claim_amount || 0;
          logger.success(`Successfully claimed ${reward} KITE rewards for subnet ${subnetId}`);
          success = true;
          break;
        } catch (error) {
          if (attempt === maxRetries) {
            logger.error(`Claim rewards error for subnet ${subnetId} after ${maxRetries} attempts: ${error.response?.data?.error || error.message}`);
            allSuccessful = false;
          }
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
      if (!success) allSuccessful = false;
    }
    
    return allSuccessful;
  } catch (error) {
    logger.error(`Claim rewards error: ${error.response?.data?.error || error.message}`);
    return false;
  }
};

const login = async (wallet, neo_session = null, refresh_token = null, maxRetries = 3) => {
  const url = 'https://neo.prod.gokite.ai/v2/signin';
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let proxy = getNextProxy();
    const axiosInstance = createAxiosInstance(proxy);
    
    try {
      logger.loading(`Logging in to ${wallet.address} (Attempt ${attempt}/${maxRetries})`);
      logger.step(`Using proxy: ${proxy ? `${proxy.host}:${proxy.port}` : 'No proxy'}`);
      
      const authToken = encryptAddress(wallet.address);
      if (!authToken) continue;
      
      const loginHeaders = {
        ...baseHeaders,
        'Authorization': authToken,
      };

      if (neo_session || refresh_token) {
        const cookies = [];
        if (neo_session) cookies.push(`neo_session=${neo_session}`);
        if (refresh_token) cookies.push(`refresh_token=${refresh_token}`);
        loginHeaders['Cookie'] = cookies.join('; ');
      }
      
      const body = { eoa: wallet.address };
      const response = await axiosInstance.post(url, body, { headers: loginHeaders });
      
      if (response.data.error) {
        logger.error(`Login failed for ${wallet.address}: ${response.data.error}`);
        continue;
      }
      
      const { access_token, aa_address, displayed_name, avatar_url } = response.data.data;
      const cookieHeader = extractCookies(response.headers);

      let resolved_aa_address = aa_address;
      if (!resolved_aa_address) {
        const profile = await getUserProfile(access_token);
        resolved_aa_address = profile?.profile?.smart_account_address;
        if (!resolved_aa_address) {
          logger.error(`No aa_address found for ${wallet.address}`);
          continue;
        }
      }
      
      logger.success(`Login successful for ${wallet.address}`);
      return { access_token, aa_address: resolved_aa_address, displayed_name, avatar_url, cookieHeader };
    } catch (error) {
      const errorMessage = error.response?.data?.error || error.message;
      logger.error(`Login attempt ${attempt} failed: ${errorMessage}`);
      if (attempt === maxRetries) {
        logger.error(`Login failed for ${wallet.address} after ${maxRetries} attempts. Check cookies or contact Kite AI support.`);
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
};

const getUserProfile = async (access_token) => {
  try {
    const proxy = getNextProxy();
    const axiosInstance = createAxiosInstance(proxy);
    logger.step(`Using proxy: ${proxy ? `${proxy.host}:${proxy.port}` : 'No proxy'}`);
    
    const response = await axiosInstance.get('https://ozone-point-system.prod.gokite.ai/me', {
      headers: { ...baseHeaders, Authorization: `Bearer ${access_token}` }
    });
    
    if (response.data.error) {
      logger.error(`Failed to fetch profile: ${response.data.error}`);
      return null;
    }
    
    return response.data.data;
  } catch (error) {
    logger.error(`Profile fetch error: ${error.response?.data?.error || error.message}`);
    return null;
  }
};

const getNextRunTime = () => {
  const now = new Date();
  now.setHours(now.getHours() + 24);
  now.setMinutes(0);
  now.setSeconds(0);
  now.setMilliseconds(0);
  return now;
};

const displayCountdown = (nextRunTime) => {
  const updateCountdown = () => {
    const now = new Date();
    const timeLeft = nextRunTime - now;
    
    if (timeLeft <= 0) {
      logger.info('Starting new daily run...');
      clearInterval(countdownInterval);
      dailyRun(); 
      return;
    }

    const hours = Math.floor(timeLeft / (1000 * 60 * 60));
    const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((timeLeft % (1000 * 60)) / 1000);
    
    process.stdout.write(`\r${colors.cyan}[⏰] Next run in: ${hours}h ${minutes}m ${seconds}s${colors.reset} `);
  };

  updateCountdown();
  const countdownInterval = setInterval(updateCountdown, 1000);
};

const dailyRun = async () => {
  logger.banner();
  
  await loadProxies();
  
  const wallets = Object.keys(process.env)
    .filter(key => key.startsWith('PRIVATE_KEY_'))
    .map(key => ({
      privateKey: process.env[key],
      neo_session: process.env[`NEO_SESSION_${key.split('_')[2]}`] || null,
      refresh_token: process.env[`REFRESH_TOKEN_${key.split('_')[2]}`] || null
    }))
    .filter(wallet => wallet.privateKey && wallet.privateKey.trim() !== '');
  
  if (wallets.length === 0) {
    logger.error('No valid private keys found in .env');
    return;
  }

  for (const { privateKey, neo_session, refresh_token } of wallets) {
    const wallet = getWallet(privateKey);
    if (!wallet) continue;
    
    logger.wallet(`Processing wallet: ${wallet.address}`);

    const loginData = await login(wallet, neo_session, refresh_token);
    if (!loginData) continue;
    
    const { access_token, aa_address, displayed_name, cookieHeader } = loginData;
    if (!aa_address) continue;

    const profile = await getUserProfile(access_token);
    
    if (profile) {
      logger.info(`User: ${profile.profile.displayed_name || displayed_name || 'Unknown'}`);
      logger.info(`EOA Address: ${profile.profile.eoa_address || wallet.address}`);
      logger.info(`Smart Account: ${profile.profile.smart_account_address || aa_address}`);
      logger.info(`Total XP Points: ${profile.profile.total_xp_points || 0}`);
      logger.info(`Referral Code: ${profile.profile.referral_code || 'None'}`);
      logger.info(`Badges Minted: ${profile.profile.badges_minted?.length || 0}`);
      logger.info(`Twitter Connected: ${profile.social_accounts?.twitter?.id ? 'Yes' : 'No'}`);
    } else {
      logger.info(`Continuing without profile data for wallet: ${wallet.address}`);
    }

    const stakeInfo = await getStakeInfo(access_token, cookieHeader);
    if (stakeInfo) {
      for (const [subnetId, info] of Object.entries(stakeInfo)) {
        if (info) {
          logger.info(`----- Stake Information for Subnet ${subnetId} -----`);
          logger.info(`My Staked Amount: ${info.my_staked_amount} tokens`);
          logger.info(`Total Staked Amount: ${info.staked_amount} tokens`);
          logger.info(`Delegator Count: ${info.delegator_count}`);
          logger.info(`APR: ${info.apr}%`);
          logger.info(`-----------------------------`);
        }
      }
    }

    await claimDailyFaucet(access_token, cookieHeader);
    await stakeToken(access_token, cookieHeader);
    await claimStakeRewards(access_token, cookieHeader);
  }
  
  logger.success('Bot execution completed');
  const nextRunTime = getNextRunTime();
  logger.info(`Next run scheduled at: ${nextRunTime.toLocaleString()}`);
  displayCountdown(nextRunTime);
};

const main = async () => {
  try {
    proxies = await loadProxies();
    if (proxies.length === 0) {
      logger.info('Running without proxies');
    }
    
    await dailyRun();
  } catch (error) {
    logger.error(`Bot error: ${error.response?.data?.error || error.message}`);
    const nextRunTime = getNextRunTime();
    logger.info(`Next run scheduled at: ${nextRunTime.toLocaleString()}`);
    displayCountdown(nextRunTime);
  }
};

main().catch(error => logger.error(`Bot error: ${error.response?.data?.error || error.message}`));
