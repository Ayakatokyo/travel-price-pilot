import {cli, Strategy} from '@jackwener/opencli/registry';
import {ArgumentError, CommandExecutionError} from '@jackwener/opencli/errors';
import {hotelArgs, validateHotelArgs, navigate, waitFor} from './browser-utils.js';

export function jalanUrl(args) {
  validateHotelArgs(args);
  if (!['Osaka','大阪'].includes(args.city)) throw new ArgumentError('This adapter has resolved Osaka only');
  if (Number(args.rooms) !== 1) throw new ArgumentError('Jalan multi-room occupancy has not been verified');
  const [year,month,day] = args.checkin.split('-').map(Number);
  const nights = Math.round((new Date(args.checkout)-new Date(args.checkin))/86400000);
  const url = new URL('https://www.jalan.net/en/japan_hotels_ryokan/Accommodation/Osaka_Accommodation/');
  const params={adultNum:args.adults,child1Num:0,child2Num:0,child3Num:0,child4Num:0,child5Num:0,
    stayYear:year,stayMonth:month,stayDay:day,stayCount:nights,roomCrack:String(args.adults)+'00000',scVal:'02'};
  for (const [key,value] of Object.entries(params)) url.searchParams.set(key,String(value));
  return url.toString();
}

function readJalan() {
  const value = name => document.querySelector(`input[name="${name}"]`)?.value ?? null;
  const iso = text => {if(!text) return null;const [m,d,y]=text.split('/');return `${y.length===2?'20'+y:y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;};
  return {host:location.hostname,path:location.pathname,
    observedSearch:{check_in:iso(value('checkinDate')),check_out:iso(value('checkoutDate')),adults:Number(value('adultNum'))||null,
      rooms:Number(value('roomCount'))||null,
      children:['children','meals-beds','meals','beds','no-meals-beds'].every(k=>value('room1-'+k)==='0')?0:null},
    queryEvidence:{check_in_text:value('checkinDate'),check_out_text:value('checkoutDate'),
      currency_basis:'JPY explicitly printed beside each room price; converted USD is reference only',
      conversion_notice:document.body.innerText.includes('displayed price in your currency is only for reference')},
    cards:[...document.querySelectorAll('.jsc-cassette-container')].map(card=>{
      const link=card.querySelector('.cassette-hotel-name a');
      const plan=card.querySelector('.cassette-hotel-plan > li');
      return {name:link?.innerText.trim(),url:link?.href,hotelId:link?.pathname.split('/').filter(Boolean).at(-1),
        priceRaw:plan?.querySelector('.final-price')?.innerText.trim()||null,
        room:plan?.querySelector('.plan-text-left')?.innerText.trim()||null,
        taxesLabel:card.querySelector('.cassette-hotel-price')?.innerText.trim()||null};
    }).filter(row=>row.name)
  };
}

export function mapJalan(state,args) {
  if (state.host!=='www.jalan.net'||!state.path.includes('/Osaka_Accommodation/')) throw new CommandExecutionError('Jalan search redirected away from Osaka');
  return state.cards.filter(card=>/^JPY\s+[\d,]+/.test(card.priceRaw||'')).slice(0,Number(args.limit)).map(card=>{
    const amount=card.priceRaw.match(/^JPY\s+([\d,]+)/)[1].replaceAll(',','');
    return {...card,schema:'hotel-observation-v1',price:amount,currency:'JPY',displayedStayTotal:amount,
      priceBasis:'listed_room_stay_total',priceLabel:'Total price',listedTaxesIncluded:/including tax and service charge/.test(card.taxesLabel||'')?true:null,
      observedSearch:state.observedSearch,queryEvidence:state.queryEvidence,conditionsVerified:true,partyParameterSupported:true,
      collectionMethod:'rendered_room_plan_cards',exhaustive:false};
  });
}

cli({site:'travel-price',name:'jalan-hotel',access:'read',description:'Jalan Osaka room prices in original JPY with dates and occupancy',
  domain:'www.jalan.net',strategy:Strategy.COOKIE,browser:true,navigateBefore:false,args:hotelArgs,
  func:async(page,args)=>{await navigate(page,jalanUrl(args));await waitFor(page,'.cassette-hotel-plan .final-price');
    return mapJalan(await page.evaluate('('+readJalan.toString()+')()'),args);}
});
