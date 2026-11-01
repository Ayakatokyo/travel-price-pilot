import {cli, Strategy} from '@jackwener/opencli/registry';
import {ArgumentError, CommandExecutionError} from '@jackwener/opencli/errors';
import {hotelArgs, validateHotelArgs, navigate, waitFor} from './browser-utils.js';

export function rakutenUrl(args) {
  validateHotelArgs(args);
  if(!['Osaka','大阪'].includes(args.city)) throw new ArgumentError('This adapter has resolved Osaka City only');
  if(Number(args.rooms)!==1) throw new ArgumentError('Rakuten multi-room queries have not been verified');
  const url=new URL('https://travel.rakuten.com/usa/en-us/hotel_list/cnt_japan/sub_osaka/cty_osaka_city/');
  for(const [key,value] of Object.entries({startServiceDate:args.checkin.replaceAll('-',''),endServiceDate:args.checkout.replaceAll('-',''),
    numberOfUnits:args.rooms,numberOfAdults_1:args.adults})) url.searchParams.set(key,String(value));
  return url.toString();
}

function readRakuten() {
  const value=id=>document.querySelector(`[data-testid="${id}"]`)?.value||null;
  const iso=raw=>/^\d{8}$/.test(raw||'')?raw.slice(0,4)+'-'+raw.slice(4,6)+'-'+raw.slice(6,8):null;
  const partyText=document.body.innerText.match(/Number of rooms[\s\S]*?Children\s+\d+/)?.[0]||'';
  const children=partyText.match(/Children\s+(\d+)/)?.[1];
  return {host:location.hostname,path:location.pathname,currency:document.querySelector('[data-testid="header-selectPopup-currency"]')?.innerText.trim(),
    observedSearch:{check_in:iso(value('dateInput-startDate-hiddenInput')),check_out:iso(value('dateInput-endDate-hiddenInput')),
      adults:Number(value('form-hiddenInput-adult'))||null,rooms:Number(value('form-hiddenInput-unit'))||null,
      children:children===undefined?null:Number(children)},
    queryEvidence:{currency_basis:'header-selectPopup-currency and US$ amount prefix',
      party_text:partyText.match(/Number of rooms[\s\S]*?Children\s+\d+/)?.[0]||null},
    cards:[...document.querySelectorAll('article[data-testid^="providerBox-article-"]')].map(card=>({
      hotelId:card.dataset.testid.replace('providerBox-article-',''),
      name:card.querySelector('[data-testid="providerHeaderBox-providerTitleBox-itemTitle"]')?.innerText.trim(),
      url:card.querySelector('a[data-testid^="providerBox-link-"]')?.href,
      priceRaw:card.querySelector('[data-testid="priceLabel-unitPrice"]')?.innerText.trim(),
      basePriceRaw:card.querySelector('[data-testid="priceLabel-basePrice"]')?.innerText.trim()||null,
      priceLabel:[card.querySelector('[data-testid="priceLabel-chargeUnit-label"]')?.innerText,card.querySelector('[data-testid="priceLabel-guestsNights-label"]')?.innerText].filter(Boolean).join(' / '),
      promotionLabel:card.querySelector('[data-testid="priceLabel-wrapper"]')?.innerText.split(/US\$/)[0].trim().replaceAll('\n',' / ')||null,
      policySummary:card.innerText.split('\n').filter(t=>/cancellation|refundable|prepayment|Room only|breakfast|cleaning|Multi-night/i.test(t)).join(' / ')||null,
    })).filter(c=>c.name)};
}

export function mapRakuten(state,args) {
  if(state.host!=='travel.rakuten.com'||!state.path.includes('/hotel_list/cnt_japan/sub_osaka/cty_osaka_city/')) throw new CommandExecutionError('Rakuten search location was not verified');
  if(state.currency!=='USD') throw new CommandExecutionError('This Rakuten amount extractor is validated for USD only');
  return state.cards.filter(c=>/^US\$[\d,]+(?:\.\d{1,2})?/.test(c.priceRaw||'')).slice(0,Number(args.limit)).map(card=>{
    const amount=card.priceRaw.match(/^US\$([\d,]+(?:\.\d{1,2})?)/)[1].replaceAll(',','');
    return {...card,schema:'hotel-observation-v1',price:amount,currency:state.currency,displayedStayTotal:amount,
      priceState:/~|～/.test(card.priceRaw)?'starting_from':'exact_display',priceBasis:'starting_room_stay_amount',
      listedTaxesIncluded:null,observedSearch:state.observedSearch,queryEvidence:state.queryEvidence,
      conditionsVerified:true,partyParameterSupported:true,collectionMethod:'rendered_search_cards',exhaustive:false};
  });
}

cli({site:'travel-price',name:'rakuten-hotel',access:'read',description:'Rakuten Osaka hotel starting prices with promotion labels',
  domain:'travel.rakuten.com',strategy:Strategy.COOKIE,browser:true,navigateBefore:false,args:hotelArgs,
  func:async(page,args)=>{await navigate(page,rakutenUrl(args));await waitFor(page,'[data-testid="priceLabel-unitPrice"]',25);
    for(let attempt=0;attempt<4;attempt++) {
      if(await page.evaluate(`/Number of rooms[\\s\\S]*?Children\\s+\\d+/.test(document.body.innerText)`)) break;
      await page.evaluate(`document.querySelector('[aria-label="Number of guests and rooms"]')?.click()`);
      await page.wait({time:1});
    }
    const state=await page.evaluate('('+readRakuten.toString()+')()');
    return mapRakuten(state,args);}
});
