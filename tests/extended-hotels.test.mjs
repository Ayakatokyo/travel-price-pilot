import test from 'node:test';
import assert from 'node:assert/strict';
import {agodaUrl,mapAgoda} from '../adapters/travel-price/agoda-hotel.js';
import {jalanUrl,mapJalan} from '../adapters/travel-price/jalan-hotel.js';
import {mapExpedia} from '../adapters/travel-price/expedia-hotel.js';
import {mapRakuten} from '../adapters/travel-price/rakuten-hotel.js';
import {tongchengUrl,checkTongchengResponse} from '../adapters/travel-price/tongcheng-hotel.js';
import {mapFliggy} from '../adapters/travel-price/fliggy-hotel.js';
import {checkQunarResponse} from '../adapters/travel-price/qunar-hotel.js';
import {tongchengFlightUrl,mapTongchengFlight} from '../adapters/travel-price/flight-probes.js';
import {mapFliggyFlight,fliggyFlightUrl} from '../adapters/travel-price/fliggy-flight.js';
import {withPageActivity} from '../adapters/travel-price/browser-utils.js';
import {expediaFlightUrl,expediaCurrentFare,mapExpediaFlight} from '../adapters/travel-price/expedia-flight.js';
import {qunarFlightUrl,qunarFlightRequest,mapQunarFlight} from '../adapters/travel-price/qunar-flight.js';

const args={city:'Osaka','city-id':'14690',checkin:'2027-01-12',checkout:'2027-01-14',adults:2,rooms:1,currency:'USD',limit:10};

test('Agoda reads the actual JPY currency behind a yen glyph without relabeling it USD',()=>{
  const rows=mapAgoda({host:'www.agoda.com',path:'/zh-cn/search',currency:'JPY',
    observedSearch:{city_id:'14690',check_in:args.checkin,check_out:args.checkout},
    queryEvidence:{check_in_text:'2027年1月12日',check_out_text:'2027年1月14日'},
    cards:[{hotelId:'example',name:'Example',priceRaw:'46,350',priceLabel:'每晚税后价'}]},args,agodaUrl(args));
  assert.equal(rows[0].currency,'JPY');
  assert.equal(rows[0].price,'46350');
  assert.equal(rows[0].displayedStayTotal,null);
});

test('Jalan uses original JPY total, not the displayed reference USD conversion',()=>{
  const [row]=mapJalan({host:'www.jalan.net',path:'/en/japan_hotels_ryokan/Accommodation/Osaka_Accommodation/',
    cards:[{name:'Example',priceRaw:'JPY 6,460\n(USD 41)',taxesLabel:'Total price (including tax and service charge)'}]},args);
  assert.equal(row.price,'6460');assert.equal(row.currency,'JPY');assert.equal(row.displayedStayTotal,'6460');
  assert.equal(row.listedTaxesIncluded,true);
  const url=new URL(jalanUrl(args));
  assert.equal(url.searchParams.get('stayCount'),'2');assert.equal(url.searchParams.get('roomCrack'),'200000');
  assert.throws(()=>jalanUrl({...args,rooms:2}),/multi-room/);
});

test('Expedia dollar parser rejects an unverified currency rather than guessing',()=>{
  assert.throws(()=>mapExpedia({host:'www.expedia.com',path:'/Hotel-Search',currency:'CAD',cards:[]},args),/USD only/);
  const [row]=mapExpedia({host:'www.expedia.com',path:'/Hotel-Search',currency:'USD',regionId:'14690',
    cards:[{name:'Example',total:'301',nightly:'136',taxesLabel:'Total with taxes and fees'}]},args);
  assert.equal(row.displayedStayTotal,'301');assert.equal(row.price,'301');
});

test('Rakuten retains starting-price qualification and conditional coupon labels',()=>{
  const [row]=mapRakuten({host:'travel.rakuten.com',path:'/usa/en-us/hotel_list/cnt_japan/sub_osaka/cty_osaka_city/',currency:'USD',
    cards:[{name:'Example',priceRaw:'US$132.02\n~',basePriceRaw:'US$165.02',promotionLabel:'Seasonal Sale / Seasonal Sale Coupon'}]},args);
  assert.equal(row.priceState,'starting_from');assert.equal(row.price,'132.02');
  assert.equal(row.promotionLabel,'Seasonal Sale / Seasonal Sale Coupon');assert.equal(row.listedTaxesIncluded,null);
});

test('Tongcheng HTTP 200 business failure is not an empty hotel inventory',()=>{
  assert.throws(()=>checkTongchengResponse({url:'https://www.ly.com/tapi/v2/nlist',responseStatus:200,
    responsePreview:JSON.stringify({error:null,errorCode:'-99'})}),error=>error.code==='PROVIDER_ERROR'&&error.message.includes('-99'));
  assert.throws(()=>tongchengUrl({...args,checkin:'2027-99-99'}),error=>error.code==='ARGUMENT');
});

test('Fliggy RMB starting prices and absent quotes remain distinct',()=>{
  const observedSearch={check_in:args.checkin,check_out:args.checkout,adults:2,rooms:1,children:0};
  const rows=mapFliggy({host:'hotel.fliggy.com',path:'/hotel_list3.htm',cityId:args['city-id'],checkIn:args.checkin,checkOut:args.checkout,partyText:'成人2位',
    cards:[{name:'Priced',priceRaw:'RMB 690 起',observedSearch},{name:'Unavailable',priceRaw:'暂无报价',observedSearch}]},args);
  assert.equal(rows[0].currency,'CNY');assert.equal(rows[0].price,'690');assert.equal(rows[0].priceState,'starting_from');
  assert.equal(rows[0].displayedStayTotal,null);assert.equal(rows[1].price,null);assert.equal(rows[1].currency,null);
});

test('Qunar denied and empty HTTP responses are not successful no-room results',()=>{
  for(const responseStatus of [204,403]) assert.throws(()=>checkQunarResponse({responseStatus,responsePreview:''}),
    error=>error.code==='PROVIDER_ERROR'&&error.message.includes(String(responseStatus)));
});

test('Tongcheng flight navigation preserves the requested date and two-adult search',()=>{
  const url=new URL(tongchengFlightUrl({from:'SHA',to:'SEL',date:'2027-01-08',adults:2}));
  assert.equal(url.searchParams.get('para'),'SHA*SEL*2027-01-08**OW*2_0_0*Y|S|C|F');
  assert.throws(()=>tongchengFlightUrl({from:'SHA',to:'SEL',date:'2027-02-30',adults:2}),error=>error.code==='ARGUMENT');
});

test('Expanded flight insurance amounts cannot become a flight quote',()=>{
  const args={from:'SHA',to:'SEL',date:'2027-01-08',adults:2,limit:10};
  const rows=mapTongchengFlight({host:'www.ly.com',path:'/iflight/book1.html',cards:[
    {priceRaw:null,expandedText:'¥60 insurance, fare ¥797'},
    {priceRaw:'¥797起',flightNos:['CZ6534','CZ675'],taxesLabel:'含税总价'}]},args,tongchengFlightUrl(args));
  assert.equal(rows.length,1);assert.equal(rows[0].price,'797');assert.equal(rows[0].priceState,'starting_from');
  assert.deepEqual(rows[0].flightNos,['CZ6534','CZ675']);
});

test('Fliggy flight extraction does not claim support for two-adult selection',()=>{
  const args={from:'SHA',to:'SEL',date:'2027-01-08',adults:2,limit:10};
  const [row]=mapFliggyFlight({host:'sijipiao.fliggy.com',path:'/ie/flight_search_result.htm',
    queryEvidence:{origin_text:'上海',destination_text:'首尔'},observedSearch:{adults:null},
    cards:[{priceRaw:'含税￥918',flightNos:['9C8559']}]},args,fliggyFlightUrl(args));
  assert.equal(row.price,'918');assert.equal(row.partyParameterSupported,false);assert.equal(row.observedSearch.adults,null);
});

test('Background activity is restored after a provider error without activating the foreground tab',async()=>{
  const previous=process.env.TRAVEL_BACKGROUND;process.env.TRAVEL_BACKGROUND='1';
  const calls=[];const page={cdp:async(method,params)=>calls.push({method,...params})};
  try {
    await assert.rejects(()=>withPageActivity(page,async()=>{throw new Error('Provider failed')}),/Provider failed/);
    assert.deepEqual(calls,[{method:'Emulation.setFocusEmulationEnabled',enabled:true},{method:'Emulation.setFocusEmulationEnabled',enabled:false}]);
  } finally {if(previous===undefined)delete process.env.TRAVEL_BACKGROUND;else process.env.TRAVEL_BACKGROUND=previous;}
});

test('Expedia current fare excludes crossed-out prices and rejects ambiguous unlabelled amounts',()=>{
  assert.equal(expediaCurrentFare('From\n$171\nOriginal price was $171\n$166\nCurrent price is $166\nOne way per traveler'),'166');
  assert.equal(expediaCurrentFare('From\n$159\n$159\nOne way per traveler'),'159');
  assert.equal(expediaCurrentFare('$159\n$166\nOne way per traveler'),null);
});

test('Expedia two-adult search keeps the displayed one-way per-traveler starting fare',()=>{
  const args={from:'SHA',to:'SEL',date:'2027-01-08',adults:2,limit:10};
  const url=expediaFlightUrl(args),params=new URL(url).searchParams;
  assert.equal(params.get('passengers'),'adults:2,infantinlap:N');
  assert.match(params.get('leg1'),/departure:1\/8\/2027TANYT/);
  const state={host:'www.expedia.com',path:'/Flights-Search',trip:'oneway',currency:'USD',cards:[
    {airline:'Example',priceRaw:'From\nStarting from this price\n$171\nOriginal price was $171\n$166\nCurrent price is $166\nOne way per traveler'}]};
  const [row]=mapExpediaFlight(state,args,url);
  assert.equal(row.price,'166');assert.equal(row.priceBasis,'one_way_per_traveler_starting_fare');
  assert.equal(row.priceState,'starting_from');assert.equal(row.currencyVerified,true);
  assert.throws(()=>mapExpediaFlight({...state,currency:'CAD'},args,url),error=>error.code==='UNVERIFIED_RESPONSE');
  assert.throws(()=>expediaFlightUrl({...args,date:'2027-02-30'}),error=>error.code==='ARGUMENT');
});

test('Qunar mobile query preserves the actual date and party while network evidence excludes account fields',()=>{
  const args={from:'SHA',to:'SEL',date:'2027-01-08',adults:2,limit:10};
  const params=new URL(qunarFlightUrl(args)).searchParams;
  assert.equal(params.get('adult'),'2');assert.equal(params.get('goDate'),args.date);
  const request=qunarFlightRequest([{url:'https://touch.qunar.com/flight/api/touchInterList',captureComplete:true,responseStatus:200,
    requestBodyPreview:JSON.stringify({depCity:'上海',arrCity:'首尔',goDate:args.date,adult:'2',child:'0',token:'private'})}]);
  assert.deepEqual(request,{origin_text:'上海',destination_text:'首尔',date:args.date,adults:2,children:0,infants:null});
  assert.equal(qunarFlightRequest([{url:'https://touch.qunar.com/flight/api/touchInterList',captureComplete:true,responseStatus:403}]),null);
});

test('Qunar upcoming service notice does not erase current per-person fares or imply two-person totals',()=>{
  const args={from:'SHA',to:'SEL',date:'2027-01-08',adults:2,limit:10};
  const state={host:'touch.qunar.com',path:'/ncs/page/interlist',trip:'oneWay',routeText:'上海首尔',date:args.date,
    priceLabel:'人均含税价',serviceNotice:'服务调整通知：将于11月4日起停止提供',
    cards:[{priceRaw:'796',arrivalTime:'12:40 +1天',airline:'Example'}]};
  const [row]=mapQunarFlight(state,{origin_text:'上海',destination_text:'首尔',date:args.date,adults:2,children:0,infants:null},args,qunarFlightUrl(args));
  assert.equal(row.price,'796');assert.equal(row.priceBasis,'listed_per_traveler_tax_inclusive_fare');
  assert.equal(row.listedTaxesIncluded,true);assert.equal(row.arrivalTime,'12:40 +1天');
  assert.equal(row.observedSearch.infants,null);assert.equal(row.currencyVerified,false);
  assert.equal(row.queryEvidence.service_notice,state.serviceNotice);
  assert.throws(()=>mapQunarFlight({...state,priceLabel:'总价'},null,args,qunarFlightUrl(args)),error=>error.code==='UNVERIFIED_RESPONSE');
});
