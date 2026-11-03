// VSB's paginator distinguishes a valid empty column from a blank/challenge page.
// This function is serialized into both the browser readiness probe and extractor.
export function isExplicitlyEmptyList(document){
  return [...document.querySelectorAll('.pb_sys_common')].some(paginator=>{
    const labels=[...paginator.querySelectorAll('.p_t')].map(node=>node.textContent.replace(/\s/g,''));
    return labels.includes('共0条')&&labels.includes('0/0');
  });
}
