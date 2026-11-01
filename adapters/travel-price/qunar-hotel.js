import {cli, Strategy} from '@jackwener/opencli/registry';
import {ArgumentError, CliError, TimeoutError} from '@jackwener/opencli/errors';
import {hotelArgs, validateHotelArgs, navigate, checkProblem, withPageActivity} from './browser-utils.js';

export function qunarUrl(args) {
  validateHotelArgs(args);
  if(!['Seoul','首尔'].includes(args.city)) throw new ArgumentError('This Qunar adapter has resolved Seoul only');
  if(Number(args.rooms)!==1||Number(args.adults)!==2) throw new ArgumentError('Only the observed two-adult, one-room Qunar query is supported');
  const url=new URL('https://hotel.qunar.com/city/i-seoul/');
  url.searchParams.set('fromDate',args.checkin);url.searchParams.set('toDate',args.checkout);
  return url.toString();
}

export function checkQunarResponse(entry) {
  const status=Number(entry.responseStatus);
  if(status!==200||!entry.responsePreview?.trim())
    throw new CliError(status===429?'RATE_LIMITED':'PROVIDER_ERROR',`Qunar /intlapi/getHotelListData: HTTP ${status}; no validated hotel response`,
      'A page showing 0 hotels while its search request fails is not evidence of no availability');
  let body;
  try{body=JSON.parse(entry.responsePreview);}catch{
    throw new CliError('PROVIDER_ERROR','Qunar hotel response was not readable JSON');
  }
  return body;
}

cli({site:'travel-price',name:'qunar-hotel',access:'read',description:'Observe Qunar Seoul search without treating failed requests as no availability',
  domain:'hotel.qunar.com',strategy:Strategy.COOKIE,browser:true,navigateBefore:false,args:hotelArgs,
  func:async(page,args)=>withPageActivity(page,async()=>{
    // Preserve a login or verification page that the user may still be completing.
    await checkProblem(page);
    await page.startNetworkCapture('/intlapi/getHotelListData');
    await navigate(page,qunarUrl(args));
    for(let i=0;i<20;i++) {
      await checkProblem(page);
      const entry=(await page.readNetworkCapture({retainIncomplete:true})).find(e=>e.captureComplete);
      if(entry) {
        checkQunarResponse(entry);
        throw new CliError('UNVERIFIED_RESPONSE','Qunar search now responds, but its quote extraction has not yet been validated',
          'Inspect response fields and rendered cards before enabling quotes');
      }
      await page.wait({time:1});
    }
    throw new TimeoutError('Qunar hotel response',20);
  })
});
