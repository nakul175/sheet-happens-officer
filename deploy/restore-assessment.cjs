// Row counts cannot prove snapshot integrity or recovery. Never turn this probe into a restore PASS.
function assessPresence(production,restored){
 const names=[...new Set([...Object.keys(production),...Object.keys(restored)])].sort();
 const missing=names.filter(n=>restored[n]===undefined);
 if(missing.length||!Number.isInteger(restored.User)||restored.User<1)return {status:'FAIL',exitCode:1,reason:'Missing tables or no restored users',missing};
 return {status:'INCONCLUSIVE',exitCode:2,reason:'Presence only: snapshot fingerprints, invariants, app smoke and recovery timing not verified',missing};
}
module.exports={assessPresence};
