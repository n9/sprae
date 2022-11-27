// directives & parsing
import sprae, { directives } from './core.js'
import { prop, input } from 'element-props'
// import { effect, computed, batch } from 'usignal'
import { effect, computed, batch } from '@preact/signals-core'
import swap from 'swapdom'
import p from 'primitive-pool'

directives[':with'] = (el, expr, rootState) => {
  let evaluate = parseExpr(expr, 'with', rootState)

  // Instead of extending signals (which is a bit hard since signal-struct internals is not uniform)
  // we bind updating
  const params = computed(() => Object.assign({}, rootState, evaluate(rootState)))
  let state = sprae(el, params.value)
  effect((values=params.value) => batch(() => Object.assign(state, values)))
  return false
}

directives[':ref'] = (el, expr, state) => {
  sprae(el, Object.assign(Object.create(state), {[expr]: el}))
  return false
}

directives[':if'] = (el, expr, state) => {
  let holder = document.createTextNode(''),
      clauses = [parseExpr(expr, ':if', state)],
      els = [el], cur = el

  while (cur = el.nextElementSibling) {
    if (cur.hasAttribute(':else')) {
      cur.removeAttribute(':else');
      if (expr = cur.getAttribute(':if')) {
        cur.removeAttribute(':if'), cur.remove();
        els.push(cur); clauses.push(parseExpr(expr, ':else :if', state));
      }
      else {
        cur.remove(); els.push(cur); clauses.push(() => 1);
      }
    }
    else break;
  }

  el.replaceWith(cur = holder)
  let idx = computed(() => clauses.findIndex(f => f(state)))
  // NOTE: it lazily initializes elements on insertion, it's safe to sprae multiple times
  effect((i=idx.value) => (els[i] != cur && ((cur[_eachHolder]||cur).replaceWith(cur = els[i] || holder), sprae(cur, state))))

  return false
}

const _eachHolder = Symbol(':each')
directives[':each'] = (tpl, expr, state) => {
  let each = parseForExpression(expr);
  if (!each) return exprError(new Error, expr);

  const getItems = parseExpr(each.items, ':each', state);

  // FIXME: make sure no memory leak here
  // we need holder to be able :if replace it instead of tpl for combined case
  const holder = tpl[_eachHolder] = document.createTextNode('')
  tpl.replaceWith(holder)

  const items = computed(()=>{
    let list = getItems(state)
    if (typeof list === 'number') return Array.from({length: list}, (_, i)=>i+1)
    return list
  })

  // stores scope per data item
  const scopes = new WeakMap()
  // element per data item
  const itemEls = new WeakMap()
  let curEls = []
  effect((list=items.value) => {
    if (!list) list = []
    // collect elements/scopes for items
    let newEls = [], elScopes = []

    for (let item of list) {
      let key = p(item)
      let el = itemEls.get(key)
      if (!el) {
        el = tpl.cloneNode(true)
        itemEls.set(key, el)
      }
      newEls.push(el)

      if (!scopes.has(key)) {
        let scope = Object.create(state)
        scope[each.item] = item
        if (each.index) scope[each.index] = i;
        scopes.set(key, scope)
      }
      elScopes.push(scopes.get(key))
    }

    // swap is really fast & tiny
    swap(holder.parentNode, curEls, newEls, holder)
    curEls = newEls

    // init new elements
    for (let i = 0; i < newEls.length; i++) {
      sprae(newEls[i], elScopes[i])
    }
  })

  return false
}

// This was taken AlpineJS, former VueJS 2.* core. Thanks Alpine & Vue!
function parseForExpression(expression) {
  let forIteratorRE = /,([^,\}\]]*)(?:,([^,\}\]]*))?$/
  let stripParensRE = /^\s*\(|\)\s*$/g
  let forAliasRE = /([\s\S]*?)\s+(?:in|of)\s+([\s\S]*)/
  let inMatch = expression.match(forAliasRE)

  if (!inMatch) return

  let res = {}
  res.items = inMatch[2].trim()
  let item = inMatch[1].replace(stripParensRE, '').trim()
  let iteratorMatch = item.match(forIteratorRE)

  if (iteratorMatch) {
      res.item = item.replace(forIteratorRE, '').trim()
      res.index = iteratorMatch[1].trim()
  } else {
      res.item = item
  }

  return res
}


// common-setter directives
directives['default'] = (el, expr, state, name) => {
  let evaluate = parseExpr(expr, ':'+name, state)
  const update = value => prop(el, name, value)
  effect(() => update(evaluate(state)))
}

directives[':aria'] = (el, expr, state) => {
  let evaluate = parseExpr(expr, ':aria', state)
  const update = (value) => {
    for (let key in value) prop(el, 'aria'+key[0].toUpperCase()+key.slice(1), value[key] == null ? null : value[key] + '');
  }
  effect(() => update(evaluate(state)))
}

directives[':data'] = (el, expr, state) => {
  let evaluate = parseExpr(expr, ':data', state)
  const value = computed(() => evaluate(state))
  effect((v=value.value) => {
    for (let key in v) el.dataset[key] = v[key];
  })
}

directives[':on'] = (el, expr, state) => {
  let evaluate = parseExpr(expr, ':on', state)
  let listeners = computed(() => evaluate(state))
  let prevListeners
  effect((values=listeners.value) => {
    for (let evt in prevListeners) el.removeEventListener(evt, prevListeners[evt]);
    prevListeners = values;
    for (let evt in prevListeners) el.addEventListener(evt, prevListeners[evt]);
  })
}

directives[':'] = (el, expr, state) => {
  let evaluate = parseExpr(expr, ':', state)
  const update = (value) => {
    if (!value) return
    for (let key in value) prop(el, key, value[key]);
  }
  effect(()=>update(evaluate(state)))
}

directives[':text'] = (el, expr, state) => {
  let evaluate = parseExpr(expr, ':text', state)

  const update = (value) => {
    el.textContent = value == null ? '' : value;
  }

  effect(()=>update(evaluate(state)))
}

// connect expr to element value
directives[':value'] = (el, expr, state) => {
  let evaluate = parseExpr(expr, ':in', state)

  let [get, set] = input(el);

  const update = (value) => {
    prop(el, 'value', value)
    set(value);
  }
  effect(()=>update(evaluate(state)))
}

let evaluatorMemo = {}

// borrowed from alpine: https://github.com/alpinejs/alpine/blob/main/packages/alpinejs/src/evaluator.js#L61
// it seems to be more robust than subscript
function parseExpr(expression, dir, scope) {
  if (evaluatorMemo[expression]) return evaluatorMemo[expression]

  // Some expressions that are useful in Alpine are not valid as the right side of an expression.
  // Here we'll detect if the expression isn't valid for an assignement and wrap it in a self-
  // calling function so that we don't throw an error AND a "return" statement can b e used.
  let rightSideSafeExpression = 0
    // Support expressions starting with "if" statements like: "if (...) doSomething()"
    || /^[\n\s]*if.*\(.*\)/.test(expression)
    // Support expressions starting with "let/const" like: "let foo = 'bar'"
    || /^(let|const)\s/.test(expression)
        ? `(() => { ${expression} })()`
        : expression;

  // guard static-time eval errors
  let evaluate
  try {
    evaluate = new Function(['scope'], `let result; with (scope) { result = (${rightSideSafeExpression}) }; return result;`)
  } catch ( e ) {
    return exprError(e, expression, dir, scope)
  }

  // guard runtime eval errors
  return evaluatorMemo[expression] = (state) => {
    let result
    try { result = evaluate(state) }
    catch (e) { return exprError(e, expression, dir, scope) }
    return result
  }
}

export function exprError(error, expression, dir, scope) {
  Object.assign( error, { expression } )
  console.warn(`∴sprae: ${error.message}\n\n${dir}=${ expression ? `"${expression}"\n\n` : '' }`, scope)
  setTimeout(() => { throw error }, 0)
}
