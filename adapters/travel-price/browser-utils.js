import {ArgumentError, CliError, EmptyResultError} from '@jackwener/opencli/errors';

export const hotelArgs = [
  {name:'city', required:true}, {name:'city-id'},
  {name:'checkin', required:true}, {name:'checkout', required:true},
  {name:'adults', type:'int', default:2}, {name:'rooms', type:'int', default:1},
  {name:'currency', default:'USD'}, {name:'limit', type:'int', default:10},
];

export function validateHotelArgs(args) {
  for (const key of ['checkin','checkout']) {
    const date=new Date(args[key]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args[key]) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== args[key])
      throw new ArgumentError('Expected a real ISO date: ' + key);
  }
  if (args.checkin >= args.checkout) throw new ArgumentError('Check-out must follow check-in');
  for (const key of ['adults','rooms','limit']) {
    if (!Number.isInteger(Number(args[key])) || Number(args[key]) < 1 || Number(args[key]) > (key === 'limit' ? 25 : 9))
      throw new ArgumentError('Invalid ' + key);
  }
  if (!/^[A-Z]{3}$/.test(args.currency)) throw new ArgumentError('Expected an ISO currency code');
}

// OpenCLI's CDP goto waits for all third-party resources. Search readiness is
// determined below by observed content, rather than by that load event.
export async function navigate(page, url) {
  if(process.env.TRAVEL_BACKGROUND!=='1') await page.cdp('Page.bringToFront');
  await page.cdp('Page.navigate', {url});
  await page.wait({time:1});
}

// Some sites defer search initialization in a background document. Chrome can
// run that document as active without switching the user's foreground tab.
export async function withPageActivity(page, work) {
  const background=process.env.TRAVEL_BACKGROUND==='1';
  if(background)await page.cdp('Emulation.setFocusEmulationEnabled',{enabled:true});
  try{return await work();}
  finally{if(background)await page.cdp('Emulation.setFocusEmulationEnabled',{enabled:false});}
}

export function pageProblem() {
  const text = document.body?.innerText || '';
  const host = location.hostname;
  const path = location.pathname;
  if (/captcha|punish/.test(path) || /verify you are human|confirm you are human|机器人验证|请完成安全验证|拖动滑块|按住.*验证|slide to verify/i.test(text.slice(0,3000)))
    return {code:'VERIFICATION_REQUIRED', message:'Complete the website verification in its browser tab'};
  if (/^(login|passport|user)\./.test(host) && /登录|sign in|log in/i.test(text.slice(0,3000)))
    return {code:'AUTH_REQUIRED', message:'This search requires the platform login'};
  return null;
}

export async function checkProblem(page) {
  const problem = await page.evaluate('(' + pageProblem.toString() + ')()');
  if (problem) throw new CliError(problem.code, problem.message, 'Use the existing browser tab', 77);
}

export async function waitFor(page, selector, seconds=18) {
  for (let i=0;i<seconds;i++) {
    await checkProblem(page);
    if (await page.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) return;
    await page.wait({time:1});
  }
  throw new EmptyResultError('hotel-search', 'No matching result cards loaded; this does not prove no availability');
}

export function numericText(text) {
  const match = String(text ?? '').trim().match(/^(?:(?:US\$|USD|JPY|CNY|¥|￥|\$)\s*)?([\d,]+(?:\.\d{1,2})?)$/);
  return match ? match[1].replaceAll(',', '') : null;
}
