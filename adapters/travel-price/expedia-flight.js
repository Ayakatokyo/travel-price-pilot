import {cli, Strategy} from '@jackwener/opencli/registry';
import {ArgumentError, CliError} from '@jackwener/opencli/errors';
import {navigate, waitFor, withPageActivity} from './browser-utils.js';
import {flightArgs, validateFlightArgs} from './flight-probes.js';

export function expediaFlightUrl(args) {
  validateFlightArgs(args);
  if(args.from!=='SHA'||args.to!=='SEL')throw new ArgumentError('Only Shanghai to Seoul has been resolved on Expedia');
  const [year,month,day]=args.date.split('-');
  const date=`${Number(month)}/${Number(day)}/${year}`;
  const url=new URL('https://www.expedia.com/Flights-Search');
  // Observed after selecting the cities, one-way, Jan 8 and two adults in the official form.
  for(const [key,value] of Object.entries({'flight-type':'on',mode:'search',trip:'oneway',
    leg1:`from:Shanghai, China (SHA-All Airports),to:Seoul, South Korea,departure:${date}TANYT,fromType:METROCODE,toType:CITY`,
    options:'cabinclass:economy',fromDate:date,d1:`${year}-${Number(month)}-${Number(day)}`,
    passengers:`adults:${args.adults},infantinlap:N`}))url.searchParams.set(key,value);
  return url.toString();
}

export function expediaCurrentFare(text) {
  const current=[...String(text).matchAll(/Current price is \$([\d,]+(?:\.\d{1,2})?)/g)].map(m=>m[1]);
  const values=current.length?current:[...String(text).matchAll(/^\$([\d,]+(?:\.\d{1,2})?)$/gm)].map(m=>m[1]);
  const unique=[...new Set(values.map(v=>v.replaceAll(',','')))];
  return unique.length===1?unique[0]:null;
}

function readExpediaFlight() {
  const value=name=>document.querySelector(`input[name="${name}"]`)?.value||null;
  const count=prefix=>{
    const input=document.querySelector(`input[id^="uitk-step-${prefix}-"]`);
    return input&&/^\d+$/.test(input.value)?Number(input.value):null;
  };
  const lap=count('infants on lap'),seat=count('infants in seat');
  return {host:location.hostname,path:location.pathname,trip:new URL(location.href).searchParams.get('trip'),
    currency:document.querySelector('[data-stid="button-type-picker-trigger"][data-context="global_navigation"]')?.innerText.match(/\b[A-Z]{3}\b/)?.[0]||null,
    observedSearch:{origin:value('EGDSSearchFormLocationField-AirportCode-origin_select'),
      destination:value('EGDSSearchFormLocationField-AirportCode-destination_select'),
      date:value('EGDSSingleDatePicker-Date-date_form_field'),adults:count('adults'),children:count('children'),
      infants:lap!==null&&seat!==null?lap+seat:null},
    queryEvidence:{origin_text:value('EGDSSearchFormLocationField-Location-origin_select'),
      destination_text:value('EGDSSearchFormLocationField-Location-destination_select'),
      travelers_text:document.querySelector('[data-stid="open-room-picker"]')?.innerText||null,
      currency_basis:'global_navigation currency picker',
      price_notice:document.querySelector('main')?.innerText.includes('Final prices and fees are confirmed before you pay.')?
        'Final prices and fees are confirmed before you pay.':null},
    cards:[...document.querySelectorAll('[data-stid="flights-standard-offer-listing"]')].map(card=>{
      const secondary=card.querySelector('[data-stid="secondary-section"]');
      const text=secondary?.innerText||'';
      const route=text.match(/^(.+\([A-Z]{3}\)) - (.+\([A-Z]{3}\))$/m);
      const times=[...(secondary?.querySelectorAll('.step-indicator-brand-color-time')||[])].map(e=>e.innerText.trim());
      const tertiary=card.querySelector('[data-stid="tertiary-section"]')?.innerText.trim()||null;
      return {priceRaw:card.querySelector('[data-stid="price-display"]')?.innerText.trim()||null,
        airline:route?text.slice(text.indexOf(route[0])+route[0].length).trim():null,
        flightNos:[],departureTime:times[0]||null,arrivalTime:times[1]||null,
        departureAirport:route?.[1]||null,arrivalAirport:route?.[2]||null,
        duration:tertiary?.split('•')[0].trim()||null,stopoverText:tertiary?.split('•').slice(1).join('•').trim()||null,
        stockHint:card.innerText.match(/\d+ left, from this price/)?.[0]||null};
    })};
}

export function mapExpediaFlight(state,args,url) {
  if(state.host!=='www.expedia.com'||state.path!=='/Flights-Search'||state.trip!=='oneway')
    throw new CliError('PROVIDER_ERROR','Expedia redirected away from the one-way flight search');
  if(state.currency!=='USD')throw new CliError('UNVERIFIED_RESPONSE','Expedia flight amount extraction is validated for explicit USD only');
  return state.cards.map(card=>({...card,price:expediaCurrentFare(card.priceRaw)}))
    .filter(card=>card.price!==null&&card.priceRaw.includes('One way per traveler')&&/Starting from this price|left, from this price/.test(card.priceRaw))
    .slice(0,Number(args.limit)).map(card=>({...card,schema:'flight-observation-v1',priceState:'starting_from',
      priceBasis:'one_way_per_traveler_starting_fare',priceLabel:'One way per traveler',currency:state.currency,currencyVerified:true,
      listedTaxesIncluded:null,taxesLabel:null,url,observedSearch:state.observedSearch,queryEvidence:state.queryEvidence,
      conditionsVerified:true,partyParameterSupported:true,collectionMethod:'rendered_search_cards',exhaustive:false}));
}

cli({site:'travel-price',name:'expedia-flight',access:'read',description:'Expedia one-way per-traveler starting fares with observed search party',
  domain:'www.expedia.com',strategy:Strategy.COOKIE,browser:true,navigateBefore:false,args:flightArgs,
  func:async(page,args)=>withPageActivity(page,async()=>{
    const url=expediaFlightUrl(args);await navigate(page,url);
    await waitFor(page,'[data-stid="flights-standard-offer-listing"] [data-stid="price-display"]',25);
    let rows=[];
    for(let i=0;i<8;i++) {
      rows=mapExpediaFlight(await page.evaluate('('+readExpediaFlight.toString()+')()'),args,url);
      if(rows.length>=Number(args.limit))break;
      await page.wait({time:0.7});
    }
    return rows;
  })
});
