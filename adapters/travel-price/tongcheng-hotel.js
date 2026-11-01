import {cli, Strategy} from '@jackwener/opencli/registry';
import {ArgumentError, CliError, TimeoutError} from '@jackwener/opencli/errors';
import {hotelArgs, validateHotelArgs, navigate, checkProblem, withPageActivity} from './browser-utils.js';

export function tongchengUrl(args) {
  validateHotelArgs(args);
  if(!/^\d+$/.test(args['city-id']||'')) throw new ArgumentError('Tongcheng requires its resolved city id');
  if(Number(args.rooms)!==1) throw new ArgumentError('Tongcheng multi-room searches have not been verified');
  const url=new URL('https://www.ly.com/hotel/hotellist');
  for(const [key,value] of Object.entries({city:args['city-id'],intl:1,inDate:args.checkin,outDate:args.checkout,adultsNumber:args.adults}))
    url.searchParams.set(key,String(value));
  return url.toString();
}

// A successful HTTP status is not a successful hotel search. Never turn the
// observed errorCode=-99 response into zero availability or invented prices.
export function checkTongchengResponse(entry) {
  const path=new URL(entry.url).pathname;
  let body;
  try {body=JSON.parse(entry.responsePreview);} catch {
    throw new CliError('PROVIDER_ERROR',`Tongcheng ${path} did not return readable search JSON`);
  }
  if(entry.responseStatus!==200 || (body.errorCode!==null && body.errorCode!==undefined && String(body.errorCode)!=='0')) {
    const code=String(body.errorCode??'unknown').replace(/[^\w-]/g,'').slice(0,30);
    throw new CliError('PROVIDER_ERROR',`Tongcheng ${path}: HTTP ${Number(entry.responseStatus)}, business errorCode=${code}`,
      'The page may display 0 hotels or NaN nights after this error; neither proves no availability');
  }
  return body;
}

cli({site:'travel-price',name:'tongcheng-hotel',access:'read',description:'Observe Tongcheng hotel search and preserve business errors',
  domain:'www.ly.com',strategy:Strategy.COOKIE,browser:true,navigateBefore:false,args:hotelArgs,
  func:async(page,args)=>withPageActivity(page,async()=>{
    await page.startNetworkCapture('/tapi/v2/');
    await navigate(page,tongchengUrl(args));
    for(let i=0;i<20;i++) {
      await checkProblem(page);
      const entries=await page.readNetworkCapture({retainIncomplete:true});
      const entry=entries.find(e=>/\/tapi\/v2\/(nlist|list)$/.test(new URL(e.url).pathname)&&e.responsePreview);
      if(entry) {
        checkTongchengResponse(entry);
        throw new CliError('UNVERIFIED_RESPONSE','Tongcheng search now responds, but its quote extraction has not yet been validated',
          'Inspect the returned search fields and rendered cards before enabling quotes');
      }
      await page.wait({time:1});
    }
    throw new TimeoutError('Tongcheng hotel search response',20);
  })
});
