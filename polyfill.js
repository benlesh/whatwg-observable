// MIT License
// copyright (c) 2017 Google, Inc, Ben Lesh, and contributors

class Observable {
  constructor(_init) {
    this._init = _init;
  }
  
  subscribe(observerOrNext, error, complete) {
    let next = observerOrNext;
    let context = this;
    if (observerOrNext && typeof observerOrNext === 'object') {
      context = observerOrNext;
      next = observerOrNext.next;
    }
    
    const ac = new AbortController();
    const subscriber = new Subscriber(next, error, complete, context, ac);
    
    let teardown;
    try {
      this._init(subscriber);
    } catch (err) {
      subscriber.error(err);
      return;
    }
    
    if (subscriber.closed) {
      teardown && teardown();
    } else {
      // TODO: this can be gotten around with a specialized AbortController.
      if (teardown) {
        let handler;
        handler = () => {
          ac.signal.removeEventListener('abort', handler);
          teardown();
        };
        ac.signal.addEventListener('abort', handler);
      }
    }
    
    return ac;
  }
  
  forEach(callback, signal) {
    if (signal.aborted) {
      return Promise.reject(new AbortError());
    }
    
    return new Promise((resolve, reject) => {
      let i = 0;
      let innerAc;
      
      const ac = this.subscribe({
        next(value, ac) {
          if (signal && !innerAc) {
            innerAc = signal.on('abort')
              .subscribe((_, innerAc) => {
                innerAc.abort();
                ac.abort();
              });
          }
          try {
            callback(value, i++);
          } catch (err) {
            reject(err);
          }
        },
        error(err) {
          reject(err);
        },
        complete() {
          resolve();
        }
      });
    });
    
    if (signal && !innerAc) {
      innerAc = addAcChild(signal, ac);
    }
  }
  
  map(project) {
    return new Observable(subscriber => {
      let i = 0;
      const ac = this.subscribe({
        next(value) {
          if (!subscriber.closed) {
            let result;
            try {
              result = project(value, i++);
            } catch (err) {
              subscriber.error(err);
              return;
            }
            subscriber.next(result);
          }
        },
        error(err) {
          subscriber.error(err);
        },
        complete() {
          subscriber.complete();
        }
      });
      
      return () => ac.abort();
    });
  }
  
  filter(predicate) {
    return new Observable(subscriber => {
      let i = 0;
      const ac = this.subscribe({
        next(value) {
          if (!subscriber.closed) {
            let result;
            try {
              result = predicate(value, i++);
            } catch (err) {
              subscriber.error(err);
              return;
            }
            if (result) {
              subscriber.next(value);
            }
          }
        },
        error(err) {
          subscriber.error(err);
        },
        complete() {
          subscriber.complete();
        }
      });
      
      return () => ac.abort();
    });
  }
  
  takeUntil(notifier) {
    return new Observable(subscriber => {
      const ac1 = notifier.subscribe({
        next() { subscriber.complete(); },
        error(err) {
          subscriber.error(err);
        },
        complete() {},
      });
      
      const ac2 = this.subscribe({
        next(value) { subscriber.next(value); },
        error(err) { subscriber.error(value); },
        complete()  { subscriber.complete(); }
      });
      
      return () => {
        ac1.abort();
        ac2.abort();
      };
    })
  }
}

function addAcChild(parentSignal, child) {
  let handler;
  handler = () => {
    parentSignal.removeEventListener('abort', handler);
    child.abort();
  };
  parentSignal.addEventListener('abort', handler);
}

class Subscriber {
  constructor(_next, _error, _complete, _context, _ac) {
    this._next = _next;
    this._error = _error;
    this._complete = _complete;
    this._context = _context;
    this._ac = _ac;
  }
  
  next(value) {
    try {
      !this.closed && this._next && this._next(value, this._ac);
    } catch (err) {
      hostReportError(err);
      this._ac.abort();
    }
  }
  
  error(err) {
    if (!this.closed) {
      this._ac.abort();
      try {
        this._error && this._error(err);
      } catch (err) {
        hostReportError(err);
      }
    }
  }
  
  complete() {
    if (!this.closed) {
      this._ac.abort();
      try { 
        this._complete && this._complete();
      } catch (err) {
        hostReportError(err);
      }
    }
  }
  
  // TODO: This an be retrieved more efficiently with a custom interal AbortController.
  get closed() {
    if (!this._signal) {
      this._signal = this._ac.signal;
    }
    
    return this._signal.aborted;
  }
}

if (!EventTarget.prototype.on) {
  EventTarget.prototype.on = function eventTargetOnPolyfill(name) {
    return new Observable((subscriber) => {
      const handler = e => subscriber.next(e);
      this.addEventListener(name, handler);
      return () => this.removeEventListener(name, handler);
    });
  }
}

function hostReportError(err) {
  setTimeout(() => { throw err; });
}
