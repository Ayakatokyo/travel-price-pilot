import {cli, Strategy} from '@jackwener/opencli/registry';
import {ArgumentError, CliError} from '@jackwener/opencli/errors';
import {navigate, waitFor, checkProblem} from './browser-utils.js';
import {flightArgs,validateFlightArgs} from './flight-probes.js';

export function fliggyFlightUrl(args) {
  validateFlightArgs(args);
  if(args.from!=='SHA'||args.to!=='SEL')throw new ArgumentError('Only Shanghai to Seoul has been resolved on Fliggy');
  const url=new URL('https://sijipiao.fliggy.com/ie/flight_search_result.htm');
  // Parameters come from the official homepage's search navigation code.
  // That form has no adult-count field; do not pretend it searched two seats.
  for(const [key,value] of Object.entries({tripType:0,depCity:args.from,arrCity:args.to,depDate:args.date,depCityName:'上海',arrCityName:'首尔'}))
    url.searchParams.set(key,String(value));
  return url.toString();
}

function readFliggyFlight() {
  const url=new URL(location.href);
  const visible=selector=>[...document.querySelectorAll(selector)].find(e=>e.getBoundingClientRect().height>0)||document.querySelector(selector);
  const child=visible('.J_Contain_Child'),infant=visible('.J_Contain_Infant');
  return {host:url.hostname,path:url.pathname,
    observedSearch:{origin:url.searchParams.get('depCity'),destination:url.searchParams.get('arrCity'),date:visible('.J_FirstDepDate')?.value||null,
      adults:null,children:child&&!child.checked?0:null,infants:infant&&!infant.checked?0:null},
    queryEvidence:{origin_text:visible('.J_DepCity')?.value,destination_text:visible('.J_ArrCity')?.value,
      adult_count:'No adult-count field in the observed search form or URL',
      currency_basis:'CNY inferred from mainland site yuan display and price aria-label ending in 元; no ISO field exposed'},
    cards:[...document.querySelectorAll('.J_FlightItem')].map(card=>{
      const main=card.querySelector('.flightInfoItem');if(!main)return null;
      const text=selector=>main.querySelector(selector)?.innerText.trim()||null;
      return {priceRaw:text('.J_FlightListPrice'),priceAccessibilityLabel:main.querySelector('.J_FlightListPrice')?.getAttribute('aria-label'),
        flightNos:[...main.querySelectorAll('[aria-label^="航班号"]')].flatMap(e=>[...e.innerText.matchAll(/\b[A-Z0-9]{2}\d{2,4}\b/g)].map(m=>m[0])),
        airline:[...new Set([...main.querySelectorAll('.airline-logo')].map(e=>e.alt).filter(Boolean))].join(' / '),
        departureTime:text('.col-time .time-info'),arrivalTime:text('.col-arr-time .time-info'),
        departureAirport:text('[aria-label^="出发机场"]'),arrivalAirport:text('[aria-label^="到达机场"]'),
        duration:text('.totalTime-info'),stopoverText:text('.transfer-city'),stockHint:text('.quantity')};
    }).filter(Boolean)};
}

export function mapFliggyFlight(state,args,url) {
  if(state.host!=='sijipiao.fliggy.com'||state.path!=='/ie/flight_search_result.htm')throw new CliError('PROVIDER_ERROR','Fliggy flight search redirected');
  return state.cards.filter(c=>/^含税[¥￥][\d,]+(?:\.\d{1,2})?$/.test(c.priceRaw||'')).slice(0,Number(args.limit)).map(card=>({
    ...card,schema:'flight-observation-v1',price:card.priceRaw.match(/[\d,]+(?:\.\d{1,2})?/)[0].replaceAll(',',''),
    priceState:'exact_display',currency:'CNY',currencyVerified:false,url,priceBasis:'listed_flight_amount_party_basis_unverified',
    taxesLabel:'含税',listedTaxesIncluded:true,observedSearch:state.observedSearch,queryEvidence:state.queryEvidence,
    conditionsVerified:state.queryEvidence.origin_text==='上海'&&state.queryEvidence.destination_text==='首尔',partyParameterSupported:false,
    collectionMethod:'rendered_search_cards',exhaustive:false}));
}

cli({site:'travel-price',name:'fliggy-flight',access:'read',description:'Fliggy international flight display prices; adult-count selection is unverified',
  domain:'sijipiao.fliggy.com',strategy:Strategy.COOKIE,browser:true,navigateBefore:false,args:flightArgs,
  func:async(page,args)=>{
    const url=fliggyFlightUrl(args);await checkProblem(page);
    const current=await page.evaluate(`({host:location.hostname,path:location.pathname,date:new URL(location.href).searchParams.get('depDate'),from:new URL(location.href).searchParams.get('depCity'),to:new URL(location.href).searchParams.get('arrCity')})`);
    if(current.host!=='sijipiao.fliggy.com'||current.path!=='/ie/flight_search_result.htm'||current.date!==args.date||current.from!==args.from||current.to!==args.to)
      await navigate(page,url);
    await waitFor(page,'.J_FlightItem .J_FlightListPrice',25);
    return mapFliggyFlight(await page.evaluate('('+readFliggyFlight.toString()+')()'),args,url);
  }
});
