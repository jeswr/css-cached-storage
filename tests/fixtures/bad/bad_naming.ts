// Bad fixture — should be flagged by Biome useNamingConvention (non-camelCase).
export function Bad_Function_Name() {
  const My_Var = 1;
  return My_Var;
}
