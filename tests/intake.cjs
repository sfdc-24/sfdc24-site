const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');
// Ported from Blackboard session/salesforce-intake at
// 1803c7f707f21e0f1b848f2d9d4bdc86865ac99a. Test the actual served source.
const file = require('node:path').join(__dirname, '../intake/index.html');
const html = fs.readFileSync(file, 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
  .filter(([, rawAttributes]) => {
    const attrs = attributes('<script ' + rawAttributes + '>');
    return !Object.hasOwn(attrs, 'src') && (!attrs.type || /^(?:text|application)\/javascript$/i.test(attrs.type));
  });
assert.equal(scripts.length, 1, 'the intake page must contain exactly one inline form script');
const script = scripts[0][2];
assert.ok(script.trim(), 'the inline form script must not be empty');

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/\s([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)]
    .map(([, name, double, single, bare]) => [name, double ?? single ?? bare ?? '']));
}
const tags = [...html.matchAll(/<(?:input|button)\b[^>]*>/gi)].map(([tag]) => attributes(tag));
const defaults = Object.fromEntries(tags.filter(a => a.name && a.name !== 'rel').map(a => [a.name, a.value || '']));
const relationships = tags.filter(a => a.type === 'radio' && a.name === 'rel');
const checkedRelationships = relationships.filter(a => Object.hasOwn(a, 'checked'));
const submitButton = [...html.matchAll(/(<button\b[^>]*>)([\s\S]*?)<\/button>/gi)]
  .find(([, tag]) => attributes(tag).id === 'submitBtn');
assert.equal(checkedRelationships.length, 1, 'the relationship radios must have exactly one checked default');
assert.ok(submitButton && /<span\b[^>]*>/.test(submitButton[2]), 'the submit button must contain its label span');

function harness(href) {
  const fields = Object.fromEntries(Object.entries(defaults).map(([k,v]) => [k,{value:v}]));
  Object.assign(fields, {first_name:{value:' SFDC24 '},last_name:{value:' Test '},email:{value:' verify@example.invalid '},company:{value:' Synthetic & Co '}});
  const handlers = {}, windowHandlers = {};
  let valid = true, done = false;
  let relationship = checkedRelationships[0].value;
  const buttonText = {textContent: ''};
  const elements = {
    leadForm: {elements:{namedItem:n=>fields[n]},querySelector(selector){
        assert.equal(selector, 'input[name="rel"]:checked', 'read the selected relationship radio');
        return {value:relationship};
      },
      addEventListener:(n,f)=>handlers[n]=f,reportValidity:()=>valid,
      reset(){
        for (const [key, value] of Object.entries(defaults)) fields[key].value = value;
        relationship = checkedRelationships[0].value;
      }},
    description: {value:'<script>not executable</script> & café',focus(){}},
    salesforceDescription:fields.description,
    submitBtn:{disabled:true,querySelector(selector){
      assert.equal(selector, 'span', 'update the submit button label');
      return buttonText;
    }},
    doneState:{classList:{add(){done=true;},remove(){done=false;}}},
    againBtn:{addEventListener:(n,f)=>handlers.again=f},
  };
  const window = {location:new URL(href),addEventListener:(n,f)=>windowHandlers[n]=f,
    history:{replaceState(a,b,url){window.location=new URL(url);}}};
  vm.runInNewContext(script,{document:{getElementById:n=>elements[n]},window,URL,URLSearchParams});
  return {fields,elements,handlers,windowHandlers,window,isDone:()=>done,setValid:v=>valid=v,
    setRelationship(value){
      assert.ok(relationships.some(a => a.value === value), 'select an existing relationship radio');
      relationship = value;
      handlers.change();
    }};
}

test('semantic markup keeps the selected org, email constraint and initially disabled submit', () => {
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(!html.includes('novalidate'));
  assert.ok(!html.includes('fakeLeadId'));
  const form = attributes(html.match(/<form\b[^>]*>/i)[0]);
  assert.equal(form.method.toUpperCase(), 'POST');
  assert.equal(form.action, 'https://webto.salesforce.com/servlet/servlet.WebToLead?encoding=UTF-8');
  const email = tags.find(a => a.id === 'email');
  assert.equal(email.type, 'email');
  assert.equal(email.maxlength, '80');
  assert.ok(Object.hasOwn(tags.find(a => a.id === 'submitBtn'), 'disabled'));
  assert.ok(Object.hasOwn(attributes('<button disabled class="submit" id="submitBtn">'), 'disabled'));
  assert.equal(submitButton[2].replace(/<[^>]*>/g, '').trim(), 'Request a demo');
  assert.equal(defaults.oid, '00Dbm00000wK2ibEAC');
  assert.equal(defaults.lead_source, 'sfdc24.com');
  assert.equal(defaults.retURL, '');
});

test('public copy describes the submission target without claiming receipt or follow-up', () => {
  assert.equal(
    attributes(html.match(/<meta\s+name="description"[^>]*>/i)[0]).content,
    'Request a demo. The form posts your details to Salesforce Web-to-Lead. This page cannot confirm receipt.'
  );
  assert.equal(
    attributes(html.match(/<meta\s+property="og:description"[^>]*>/i)[0]).content,
    'Request a demo. The form posts your details to Salesforce Web-to-Lead. This page cannot confirm receipt.'
  );
  assert.match(html, /<title>Request a demo &mdash; SFDC24<\/title>/);
  assert.match(html, /<div class="eyebrow">Request a demo<\/div>/);
  assert.match(html, /<h1>Interested in a demo\?<\/h1>/);

  for (const required of [
    'your browser posts your details to Salesforce Web-to-Lead',
    'This page cannot confirm that Salesforce received or stored them.',
    'automation and AI enablement',
    'Submission status unconfirmed.',
    'Return to form',
    'If it reaches SFDC24, we may review it and contact you',
    'No custom field is used.',
  ]) {
    assert.ok(html.includes(required), `expected truthful intake copy: ${required}`);
  }

  for (const unsupported of [
    'Salesforce connected',
    'land straight',
    'success partner picks it up',
    'We turn it into a sketch, a prototype, and a quote',
    'Send it to a success partner',
    'Submission sent.',
    'Submit another request',
    'Intake is connected',
    'Connected · requests are sent',
    'sent to SFDC24 for review',
    'sent to SFDC 24 for review',
    "is saved with the request in the Lead's Description",
    'We review your request and contact you',
    'leads flow to Salesforce',
    'Salesforce lead assembles here in real time',
    'Assignment rule routes it; an Agentforce agent drafts the first reply.',
    'the "success partner" for life',
    'Live payload',
    'It reaches a person, not a queue.',
    'Behind the glass',
    'planned salesforce pipeline',
    'Form payload preview',
    'Intake prototype',
    'Submit request',
    'id="payloadView"',
  ]) {
    assert.ok(!html.includes(unsupported), `unsupported intake claim must stay absent: ${unsupported}`);
  }
  assert.doesNotMatch(html, /class="stage"|id="epLabel"|id="st[1-5]"/,
    'the planned pipeline chrome must stay off the form');
});

test('preview, public and nested routes return to their own host and path without private URL data', () => {
  for (const href of ['https://sfdc24-intake-omnistudio.astronautwannabe.chatgpt.site/',
    'https://www.sfdc24.com/intake/?preview=private#session',
    'http://localhost:3000/nested/form.html?submitted=1&token=private#details']) {
    const h = harness(href);
    const current = new URL(href);
    const expected = current.origin + current.pathname + '?submitted=1';
    assert.equal(h.fields.retURL.value, expected);
    assert.equal(h.fields.oid.value, '00Dbm00000wK2ibEAC');
    assert.equal(h.fields.lead_source.value, 'sfdc24.com');
    assert.equal(h.elements.submitBtn.disabled, false);
  }
});

test('submitted page resets and restores the return URL for a second request', () => {
  const h = harness('https://www.sfdc24.com/intake/?submitted=1');
  assert.equal(h.isDone(), true);
  assert.equal(h.elements.leadForm.hidden, true);
  h.handlers.again();
  assert.equal(h.isDone(), false);
  assert.equal(h.elements.leadForm.hidden, false);
  assert.equal(h.window.location.search, '');
  assert.equal(h.fields.retURL.value, 'https://www.sfdc24.com/intake/?submitted=1');
});

test('invalid input is blocked; valid input uses native POST with literal relationship text', () => {
  const h = harness('https://www.sfdc24.com/intake/');
  h.setRelationship('Supplier');
  let prevented = false;
  h.setValid(false);
  h.handlers.submit({preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  assert.equal(h.elements.submitBtn.disabled,false);
  h.setValid(true);
  prevented=false;
  h.handlers.submit({preventDefault(){prevented=true;}});
  assert.equal(prevented,false);
  assert.equal(h.elements.submitBtn.querySelector('span').textContent,'Sending to Salesforce…');
  assert.equal(h.fields.email.value,'verify@example.invalid');
  assert.equal(h.fields.description.value,'[SFDC24 demo interest] Relationship: Supplier\n\n<script>not executable</script> & café');
  assert.equal(h.fields.company.value,'Synthetic & Co');
  assert.equal(h.fields.oid.value,defaults.oid);
  assert.equal(h.fields.lead_source.value,'sfdc24.com');
  const posted = new Map([['rel','Supplier'],['description',h.fields.description.value]]);
  h.handlers.formdata({formData:posted});
  assert.equal(posted.has('rel'),false);
  assert.ok(posted.has('description'));
  assert.equal(h.elements.submitBtn.disabled,true);
  h.windowHandlers.pageshow();
  assert.equal(h.elements.submitBtn.disabled,false);
  assert.equal(h.elements.submitBtn.querySelector('span').textContent,'Request a demo');
});

test('changing the selected relationship updates the submitted description', () => {
  const h = harness('https://www.sfdc24.com/intake/');
  for (const value of ['Supplier', 'Customer']) {
    h.setRelationship(value);
    assert.ok(h.fields.description.value.startsWith('[SFDC24 demo interest] Relationship: ' + value + '\n\n'));
  }
});

test('local file previews cannot submit with an unusable return URL', () => {
  const h = harness('file:///tmp/intake.html');
  assert.equal(h.elements.submitBtn.disabled,true);
  assert.equal(h.fields.retURL.value,'');
});

test('the skip link targets the request panel, which contains both form states', () => {
  // The ?submitted=1 state hides #leadForm, so a skip link aimed at the form
  // would send keyboard users to a hidden element. The contract is that the
  // link targets the panel that WRAPS both the form and the done state.
  const skip = html.match(/<a\b[^>]*\bclass="skip"[^>]*>/i);
  assert.ok(skip, 'the skip link must exist');
  assert.equal(attributes(skip[0]).href, '#request');
  const target = html.match(/<section\b[^>]*\bid="request"[^>]*>/i);
  assert.ok(target, 'the skip target #request must exist');
  assert.equal(attributes(target[0]).tabindex, '-1', 'the target must accept programmatic focus');
  const panel = html.slice(html.indexOf(target[0]));
  const inner = panel.slice(0, panel.indexOf('</section>'));
  assert.ok(inner.includes('id="leadForm"'), 'the panel must contain the form');
  assert.ok(inner.includes('id="doneState"'),
    'the panel must contain the done state, so the target stays visible when ?submitted=1 hides the form');
});

test('the relationship radiogroup is named by its visible prompt', () => {
  // aria-label would let assistive technology announce a different name than
  // sighted users read; the group must reference the visible prompt instead.
  const group = html.match(/<div\b[^>]*\brole="radiogroup"[^>]*>/i);
  assert.ok(group, 'the radiogroup must exist');
  const groupAttrs = attributes(group[0]);
  assert.equal(groupAttrs['aria-labelledby'], 'rel-prompt');
  assert.ok(!Object.hasOwn(groupAttrs, 'aria-label'),
    'an aria-label would override the visible prompt as the accessible name');
  const prompt = html.match(/<label\b[^>]*\bid="rel-prompt"[^>]*>([\s\S]*?)<\/label>/i);
  assert.ok(prompt, 'the visible prompt #rel-prompt must exist');
  assert.equal(prompt[1].replace(/<[^>]*>/g, '').trim(), 'You are a…');
  assert.match(html, /<span class="box">Collaborator<\/span>/, 'the visible choice is Collaborator');
  assert.doesNotMatch(html, /\bpartner\b/i, 'the intake page must not say partner');
  assert.match(html, /value="Supplier"/, 'the posted value stays Supplier so the intake contract is unchanged');
});

test('the homepage interest action opens /intake/ and is not a mailto', () => {
  const home = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
  const actions = home.match(/<div class="sh-actions">([\s\S]*?)<\/div>/);
  assert.ok(actions, 'homepage hero actions must exist');
  assert.match(actions[1], /<a class="sh-ghost" href="\/intake\/">Request a demo<\/a>/);
  assert.doesNotMatch(actions[1], /mailto:/, 'the primary demo action must not be a mailto');
  assert.match(home, /<footer[\s\S]*?<a href="\/intake\/">Demo<\/a>/);
  assert.match(home, /<a href="mailto:abdus@sfdc24\.com">abdus@sfdc24\.com<\/a>/,
    'email contact stays on the homepage');
  const chrome = fs.readFileSync(require('node:path').join(__dirname, '../assets/chrome.js'), 'utf8');
  assert.match(chrome, /\["\/intake\/", "Demo", ""\]/, 'shared footer must link the demo form');
});

test('the studio finish link still opens /intake/', () => {
  const studio = fs.readFileSync(require('node:path').join(__dirname, '../studio/index.html'), 'utf8');
  assert.match(studio, /<a class="studio-finish-next" href="\/intake\/">Describe an idea to try<\/a>/);
});
