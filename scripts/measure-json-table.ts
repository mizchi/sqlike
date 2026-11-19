import { jsonTableFunctions } from "../src/sqlike-features.ts";
import { measureOptionalFeature } from "./measure-optional-feature.ts";

await measureOptionalFeature({
  id:"json-table",feature:jsonTableFunctions,runner:"scripts/measure-json-table.ts",
  catalog:{schema:[],queries:[{name:"q",sql:"SELECT key,value,type,id,parent,fullkey,path FROM json_tree('[1]')"}]},
  expected:[[null,"[1]","array",0n,null,"$","$"],[0n,1n,"integer",1n,0n,"$[0]","$"]],
});
