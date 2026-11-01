import {cli, Strategy} from '@jackwener/opencli/registry';
import {ArgumentError, CommandExecutionError} from '@jackwener/opencli/errors';
import {hotelArgs, validateHotelArgs, navigate, waitFor} from './browser-utils.js';

export function fliggyUrl(args) {
  validateHotelArgs(args);
  if(!/^\d+$/.test(args['city-id']||'')) throw new ArgumentError('Fliggy requires its resolved city code');
  if(Number(args.rooms)!==1) throw new ArgumentError('Fliggy multi-room queries have not been verified');
  const url=new URL('https://hotel.fliggy.com/hotel_list3.htm');
  for(const [key,value] of Object.entries({city:args['city-id'],checkIn:args.checkin,checkOut:args.checkout,
    roomNum:args.rooms,aNum_1:args.adults,cNum_1:0})) url.searchParams.set(key,String(value));
  return url.toString();
}

function readFliggy() {
  const value=name=>document.querySelector(`input[name="${name}"]`)?.value||null;
  const partyText=document.querySelector('.J_simulate_value')?.innerText.trim()||null;
  return {host:location.hostname,path:location.pathname,cityId:value('city'),checkIn:value('checkIn'),checkOut:value('checkOut'),partyText,
    cards:[...document.querySelectorAll('.J_ListRow')].map(card=>{
      const link=card.querySelector('.row-title a');
      if(!link)return null;
      const url=new URL(link.href),get=key=>url.searchParams.get(key);
      const count=key=>get(key)===null?null:Number(get(key));
      return {hotelId:get('shid'),name:link.innerText.trim(),url:link.href,
        address:card.querySelector('.row-address')?.innerText.trim()||null,
        priceRaw:card.querySelector('.hotel-price')?.innerText.trim()||null,
        observedSearch:{check_in:get('checkIn'),check_out:get('checkOut'),adults:count('aNum_1'),rooms:count('roomNum'),children:count('cNum_1')}};
    }).filter(Boolean)};
}

export function mapFliggy(state,args) {
  if(state.host!=='hotel.fliggy.com'||state.path!=='/hotel_list3.htm'||state.cityId!==args['city-id'])
    throw new CommandExecutionError('Fliggy hotel search location was not verified');
  return state.cards.slice(0,Number(args.limit)).map(card=>{
    const price=card.priceRaw?.match(/^RMB\s+([\d,]+(?:\.\d{1,2})?)\s*起$/)?.[1]?.replaceAll(',','')||null;
    const observed=card.observedSearch;
    return {...card,schema:'hotel-observation-v1',price,currency:price?'CNY':null,priceState:'starting_from',
      priceBasis:'starting_display_period_unverified',priceLabel:card.priceRaw,displayedStayTotal:null,listedTaxesIncluded:null,
      conditionsVerified:observed.check_in===state.checkIn&&observed.check_out===state.checkOut&&state.partyText===`成人${observed.adults}位`,
      queryEvidence:{currency_basis:price?'RMB explicitly printed in hotel price':null,city_id:state.cityId,party_text:state.partyText,
        occupancy_basis:'search control adult count and platform-generated property link roomNum/aNum_1/cNum_1'},
      partyParameterSupported:true,collectionMethod:'rendered_search_cards',exhaustive:false};
  });
}

cli({site:'travel-price',name:'fliggy-hotel',access:'read',description:'Fliggy hotel metadata and RMB starting prices when exposed by the page',
  domain:'hotel.fliggy.com',strategy:Strategy.COOKIE,browser:true,navigateBefore:false,args:hotelArgs,
  func:async(page,args)=>{
    await navigate(page,fliggyUrl(args));await waitFor(page,'.J_ListRow .row-title a');
    await page.wait({time:3});
    for(let i=0;i<12;i++) {
      if(await page.evaluate(`[...document.querySelectorAll('.J_ListRow .hotel-price')].some(e=>/RMB\\s+\\d|请登录查看报价/.test(e.innerText))`))break;
      await page.wait({time:1});
    }
    return mapFliggy(await page.evaluate('('+readFliggy.toString()+')()'),args);
  }
});
