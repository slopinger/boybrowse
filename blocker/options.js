const form = document.getElementById('options');
const enabled = document.getElementById('enabled');
const exceptions = document.getElementById('exceptions');
const status = document.getElementById('status');
chrome.storage.local.get({enabled:true,exceptions:[]}).then(options => {
  enabled.checked = options.enabled; exceptions.value = options.exceptions.join('\n');
});
form.addEventListener('submit',async event => {
  event.preventDefault();
  try {
    const domains = [...new Set(exceptions.value.split(/\s+/).filter(Boolean).map(value => value.toLowerCase()))];
    if (domains.length > 100 || domains.some(domain => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))) throw new Error('Enter up to 100 hostnames, without schemes or paths.');
    const previous = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds:previous.map(rule => rule.id),
      addRules:domains.map((domain,index) => ({id:index + 10000,priority:100,
        action:{type:'allow'},condition:{initiatorDomains:[domain]}}))
    });
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds:enabled.checked ? ['starter'] : [],
      disableRulesetIds:enabled.checked ? [] : ['starter']
    });
    await chrome.storage.local.set({enabled:enabled.checked,exceptions:domains});
    status.textContent = 'Saved. Your shields settings are active.';
  } catch (error) {status.textContent = error.message;}
});
