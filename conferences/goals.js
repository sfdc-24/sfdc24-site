(function(){
var el=document.getElementById("conference-goals");if(!el)return;
var num=document.getElementById("conference-goals-num"),live=document.getElementById("conference-goals-live"),rows=el.querySelectorAll(".goal"),n=rows.length,step=n,t=0,hold=0,primed=0,seen=0,reduce=0,mq=null;
try{mq=matchMedia("(prefers-reduced-motion: reduce)");reduce=!!mq.matches}catch(e){}
function paint(){for(var i=0;i<n;i++)rows[i].className="goal"+(i<step?" is-done":i==step?" is-lit":"");num.textContent=step}
function stop(){clearTimeout(t);t=0}
function still(){stop();primed=hold=0;step=n;paint();live.textContent="";el.classList.remove("is-live")}
function queue(){if(t||reduce||!seen||document.hidden)return;t=setTimeout(tick,hold?1800:900)}
function tick(){t=0;if(hold){hold=0;step=0;live.textContent=""}else if(step<n){step++;if(step==n){hold=1;live.textContent=n+" of "+n+" done"}}paint();queue()}
function sync(){if(reduce||typeof IntersectionObserver!="function")return still();if(!primed){primed=1;hold=0;step=0;live.textContent="";paint()}var on=seen&&!document.hidden;el.classList.toggle("is-live",on);on?queue():stop()}
if(mq){var onq=function(){reduce=!!mq.matches;if(reduce)primed=0;sync()};if(mq.addEventListener)mq.addEventListener("change",onq);else if(mq.addListener)mq.addListener(onq)}
document.addEventListener("visibilitychange",sync);
if(typeof IntersectionObserver!="function"){still();return}
el.classList.add("is-armed");sync();
new IntersectionObserver(function(es){var e=es[es.length-1];seen=!!(e&&e.isIntersecting&&e.intersectionRatio>=.35);sync()},{threshold:[0,.35]}).observe(el);
})();
