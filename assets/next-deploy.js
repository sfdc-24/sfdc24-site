/* RELEASE RAIL stub — full rail loads below */
(function(){"use strict";
var PROMISED="2026-09-19T02:30:00-04:00";
function since(){return"4 Sep 2026";}
function clock(){
  try{
    var h="00",m="00",D="01",M="01",Y="2026";
    new Intl.DateTimeFormat("en-GB",{timeZone:"America/Toronto",hour:"2-digit",minute:"2-digit",day:"2-digit",month:"2-digit",year:"numeric",hourCycle:"h23"}).formatToParts(new Date()).forEach(function(p){
      if(p.type==="hour")h=p.value; if(p.type==="minute")m=p.value;
      if(p.type==="day")D=p.value; if(p.type==="month")M=p.value; if(p.type==="year")Y=p.value;
    });
    function z(s){return("0"+String(s).replace(/\D/g,"").slice(-2)).slice(-2);}
    h=z(h);m=z(m);D=z(D);M=z(M);
    return{t:h+":"+m,dmy:D+"/"+M+"/"+Y,full:h+":"+m+" "+D+"/"+M+"/"+Y};
  }catch(e){return{t:"00:00",dmy:"01/01/2026",full:"00:00 01/01/2026"};}
}
function boot(){
  var root=document.getElementById("nextDeploy");
  if(!root){root=document.createElement("aside");root.id="nextDeploy";root.style.cssText="position:fixed;top:72px;right:10px;z-index:45;width:220px;padding:10px;background:#032D60;color:#fff;border-radius:8px;font:600 11px/1.35 ui-monospace,Menlo,monospace";document.body.appendChild(root);}
  function paint(){
    var c=clock();
    root.innerHTML='<div style="display:flex;justify-content:space-between"><b style="color:#57C1FF">RELEASE</b><span>SFDC<span style="color:#57C1FF">'+c.t+'</span> '+c.dmy+'</span></div><div style="font:500 9px/1.2 system-ui,sans-serif;color:#9BD4FF;text-align:right">Started since '+since()+'</div><div style="margin-top:6px;color:#E3EBF4">AI Fitness — 24 · estimate vs execution</div><div style="margin-top:4px">ETA <b id="ndEst">--:--</b> · rem <b id="ndRem">--:--</b></div>';
    var m=document.querySelector("a.mark");
    if(m){m.innerHTML="SFDC<span>"+c.t+"</span> <span style=\"font:600 10px/1 ui-monospace,Menlo,monospace;color:#CFE9FF\">"+c.dmy+"</span><span style=\"display:block;font:500 9px/1.2 system-ui,sans-serif;color:#9BD4FF\">Started since "+since()+"</span>";}
    var iso=window.__SFDC24_NEXT_DEPLOY||PROMISED,p=Date.parse(iso),now=Date.now();
    function pad(n){return(n<10?"0":"")+n;}
    function fmt(ms){var s=Math.floor(Math.abs(ms)/1000),h=Math.floor(s/3600);s%=3600;var m=Math.floor(s/60);s%=60;return(ms<0?"-":"")+(h>0?h+":"+pad(m)+":"+pad(s):m+":"+pad(s));}
    try{var hh="00",mm="00";new Intl.DateTimeFormat("en-GB",{timeZone:"America/Toronto",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(p)).forEach(function(x){if(x.type==="hour")hh=x.value;if(x.type==="minute")mm=x.value;});
      var est=document.getElementById("ndEst"); if(est) est.textContent=("0"+hh.replace(/\D/g,"")).slice(-2)+":"+("0"+mm.replace(/\D/g,"")).slice(-2);
    }catch(e){}
    var rem=document.getElementById("ndRem"); if(rem&&isFinite(p)) rem.textContent=fmt(p-now);
  }
  paint(); setInterval(paint,1000);
  window.__SFDC24_NEXT_DEPLOY=window.__SFDC24_NEXT_DEPLOY||PROMISED;
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();
})();
