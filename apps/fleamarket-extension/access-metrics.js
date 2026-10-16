export function newAccessMetrics(job){
 return {runId:job.id,day:job.day,manual:job.manual===true,startedAt:new Date().toISOString(),unit:'page-navigation',total:0,accounts:job.accounts.map(a=>({id:a.id,label:a.label,site:a.site,total:0,list:0,detail:0,identity:0}))};
}
export function incrementAccess(metrics,account,kind){
 if(!['list','detail','identity'].includes(kind))throw new Error('Unknown navigation kind');
 const next=structuredClone(metrics),row=next.accounts.find(a=>a.id===account.id&&a.site===account.site);
 if(!row)throw new Error('Navigation account is outside the run');
 row[kind]++;row.total++;next.total++;return next;
}
