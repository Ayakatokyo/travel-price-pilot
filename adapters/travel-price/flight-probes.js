import {cli, Strategy} from '@jackwener/opencli/registry';
import {ArgumentError, CliError} from '@jackwener/opencli/errors';
import {navigate, checkProblem, waitFor, withPageActivity} from './browser-utils.js';

export const flightArgs=[{name:'from',positional:true,required:true},{name:'to',positional:true,required:true},
  {name:'date',required:true},{name:'adults',type:'int',required:true},{name:'limit',type:'int',default:10}];

export function validateFlightArgs(args) {
  const date=new Date(args.date);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(args.date)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==args.date)
    throw new ArgumentError('A real ISO departure date is required');
  if(!/^[A-Z]{3}$/.test(args.from)||!/^[A-Z]{3}$/.test(args.to)||!Number.isInteger(Number(args.adults))||args.adults<1||args.adults>9)
    throw new ArgumentError('Expected IATA origin/destination and 1-9 adults');
}

export function tongchengFlightUrl(args) {
  validateFlightArgs(args);
  if(args.from!=='SHA'||args.to!=='SEL')throw new ArgumentError('Only Shanghai to Seoul has been resolved on Tongcheng');
  const url=new URL('https://www.ly.com/iflight/book1.html');
  // Format observed from the site's own Shanghai–Seoul search navigation.
  url.searchParams.set('para',`${args.from}*${args.to}*${args.date}**OW*${args.adults}_0_0*Y|S|C|F`);
  url.searchParams.set('departureCity','上海');url.searchParams.set('arrivalCity','首尔');url.searchParams.set('advanced','false');
  return url.toString();
}

function readTongchengFlight() {
  const url=new URL(location.href),inputs=[...document.querySelectorAll('input.v-input_field')];
  const adultText=document.querySelector('#adultId .v-select-field')?.innerText||'';
  const childText=document.querySelector('#childrenId .v-select-field')?.innerText||'';
  const count=text=>{const m=text.match(/\d+/);return m?Number(m[0]):null;};
  const parts=(url.searchParams.get('para')||'').split('*');
  const party=(parts[5]||'').split('_');
  return {host:url.hostname,path:url.pathname,searchKey:parts.slice(0,6).join('*'),
    observedSearch:{origin:inputs[0]?.value.match(/\(([A-Z]{3})\)/)?.[1]||null,
      destination:inputs[1]?.value.match(/\(([A-Z]{3})\)/)?.[1]||null,date:inputs[2]?.value.match(/^\d{4}-\d{2}-\d{2}/)?.[0]||null,
      adults:count(adultText),children:count(childText),infants:party[2]==='0'?0:null},
    queryEvidence:{adult_text:adultText,child_text:childText,date_text:inputs[2]?.value,
      result_count_text:document.body.innerText.match(/单程：[^\n]+个航班[^\n]+/)?.[0]||null,
      currency_basis:'CNY inferred from the mainland site yuan display; no ISO currency field exposed'},
    cards:[...document.querySelectorAll('.flight-item')].map(card=>{
      const main=card.querySelector('.flight-item-main');if(!main)return null;
      const text=selector=>main.querySelector(selector)?.innerText.trim()||null;
      return {priceRaw:text('.flight-price .price-info'),taxesLabel:text('.flight-price .tax-text'),
        flightNos:[...main.querySelectorAll('.airways-model')].map(e=>e.innerText.match(/^([A-Z0-9]{2}\d{2,4})\b/)?.[1]).filter(Boolean),
        airline:[...new Set([...main.querySelectorAll('.airways-title')].map(e=>e.innerText.trim()))].join(' / '),
        departureTime:text('.depart-time'),arrivalTime:text('.arrive-time'),departureAirport:text('.depart-airport'),arrivalAirport:text('.arrive-airport'),
        duration:text('.arrow-time'),stopoverText:[...main.querySelectorAll('.arrow-item')].map(e=>e.innerText.trim()).join(' / ')||null,
        stockHint:main.innerText.match(/余\d+张/)?.[0]||null};
    }).filter(Boolean)};
}

export function mapTongchengFlight(state,args,url) {
  if(state.host!=='www.ly.com'||state.path!=='/iflight/book1.html')throw new CliError('PROVIDER_ERROR','Tongcheng flight search redirected');
  return state.cards.filter(c=>/^[¥￥][\d,]+(?:\.\d{1,2})?起?$/.test(c.priceRaw||'')).slice(0,Number(args.limit)).map(card=>({
    ...card,schema:'flight-observation-v1',price:card.priceRaw.match(/[\d,]+(?:\.\d{1,2})?/)[0].replaceAll(',',''),
    priceState:card.priceRaw.endsWith('起')?'starting_from':'exact_display',currency:'CNY',currencyVerified:false,url,
    priceBasis:'listed_flight_amount_party_basis_unverified',listedTaxesIncluded:card.taxesLabel?.includes('含税')?true:null,
    observedSearch:state.observedSearch,queryEvidence:state.queryEvidence,conditionsVerified:true,partyParameterSupported:true,
    collectionMethod:'rendered_search_cards',exhaustive:false}));
}

cli({site:'travel-price',name:'qunar-flight-desktop-probe',access:'read',description:'Check the legacy Qunar desktop flight portal separately from its mobile-web service',
  domain:'flight.qunar.com',strategy:Strategy.COOKIE,browser:true,navigateBefore:false,args:flightArgs,
  func:async(page,args)=>withPageActivity(page,async()=>{
    validateFlightArgs(args);await navigate(page,'https://flight.qunar.com/site/');await page.wait({time:5});await checkProblem(page);
    const stopped=await page.evaluate(`document.body.innerText.includes('网页版机票查询及预订服务')&&document.body.innerText.includes('停止提供')`);
    if(stopped)throw new CliError('WEB_UNAVAILABLE','Qunar displays a notice that web flight search and booking will stop from October 10; the notice does not specify a year',
      'No dated flight quote was returned; use a supported official channel');
    throw new CliError('UNVERIFIED_RESPONSE','The previous Qunar web-service notice is absent; the flight search must be revalidated');
  })
});

cli({site:'travel-price',name:'tongcheng-flight',access:'read',description:'Tongcheng Shanghai–Seoul flight search with an explicit adult count',
  domain:'www.ly.com',strategy:Strategy.COOKIE,browser:true,navigateBefore:false,args:flightArgs,
  func:async(page,args)=>{
    const url=tongchengFlightUrl(args);
    await checkProblem(page); // Leave a pending manual login untouched.
    const expected=new URL(url).searchParams.get('para');
    const current=await page.evaluate(`({host:location.hostname,path:location.pathname,para:new URL(location.href).searchParams.get('para')})`);
    if(current.host!=='www.ly.com'||current.path!=='/iflight/book1.html'||current.para!==expected)await navigate(page,url);
    await waitFor(page,'.flight-item-main .flight-price .price-info',25);
    return mapTongchengFlight(await page.evaluate('('+readTongchengFlight.toString()+')()'),args,url);
  }
});
