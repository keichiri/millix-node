import database from '../database/database';
import ntp from '../core/ntp';
import axios from 'axios';


function test() {
    console.log('\n\n\nTEEEST\n\n');
}


class TriggerEngine {
    constructor() {
        this._triggers          = {};
        this._triggerNamesToIDs = {};
        this._triggerActions    = {};
        this.initialized        = false;
        this.repository         = undefined;
        this._modules           = {
            'test': {
                test: test
            }
        };  // TODO
    }

    // Reads all the triggers and trigger actions and stores it in memory
    initialize() {
        this.repository = database.getRepository('trigger');
        console.log('[Trigger Engine] Initializing trigger engine. Getting triggers from the database');

        return this.repository.getAllTriggers()
                   .then(trigger_rows => {
                       for (let triggerRow of trigger_rows) {
                           console.log(`[Trigger Engine] Trigger Row: ${JSON.stringify(triggerRow)}`);
                           this._triggers[triggerRow.id]                    = triggerRow;
                           this._triggerNamesToIDs[triggerRow.trigger_name] = triggerRow.id;
                           this._triggerActions[triggerRow.id]              = [];
                       }

                       console.log(`[Trigger Engine] ${trigger_rows.length} triggers retrieved from the database`);
                       console.log('[Trigger Engine] Getting trigger actions from the database');

                       this.repository.getAllActions()
                           .then(triggerActionRows => {
                               for (let triggerActionRow of triggerActionRows) {
                                   triggerActionRow.action = JSON.parse(triggerActionRow.action);
                                   const triggerID         = triggerActionRow.trigger_id;
                                   this._triggerActions[triggerID].push(triggerActionRow);
                               }

                               console.log(`[Trigger Engine] ${triggerActionRows.length} trigger actions retrieved from the database`);
                               console.log(`[Trigger Engine] Successfully initialized`);

                               this.initialized = true;
                           })
                           .catch(err => {
                               console.log(`[Trigger Engine] Failed to get all actions: ${err}`);
                               throw err;
                           });
                   })
                   .catch(err => {
                       console.log(`[Trigger Engine] Error while initializing: ${err}`);
                       throw Error('Could not initialize trigger engine');
                   });
    }

    addTrigger(trigger, triggerActions) {
        console.log('[Trigger Engine] Adding new trigger');

        return this.repository.addTriggerWithActions(trigger, triggerActions)
                   .then(triggerID => {
                       this._triggerNamesToIDs[trigger.name] = triggerID;
                       this._triggers[triggerID]             = trigger;
                       this._triggerActions[triggerID]       = triggerActions;

                       console.log('[Trigger Engine] Successfully added new trigger');
                   })
                   .catch(err => {
                       throw Error(`Could not store trigger. Error: ${err}`);
                   });
    }

    addTriggerAction(triggerName, action) {
        console.log(`[Trigger Engine] Adding trigger action to trigger ${triggerName}. Retrieving trigger ID`);

        const triggerID = this._triggerNamesToIDs[triggerName];

        return this.repository.addAction(triggerID, action)
                   .then(_ => {
                       this._triggerActions[triggerID].push(action);
                       console.log('[Trigger Engine] Successfully added new trigger action');
                   })
                   .catch(err => {
                       throw Error(`Could not add trigger action. Error:  ${err}`);
                   });
    }

    checkTriggerExists(triggerName) {
        console.log(`[Trigger Engine] Checking if trigger ${triggerName} exists`);

        return triggerName in this._triggerNamesToIDs;
    }

    isTriggerDisabled(triggerName) {
        const triggerID = this._triggerNamesToIDs[triggerName];
        const trigger   = this._triggers[triggerID];
        return (trigger.status === 0);
    }

    checkActionExists(triggerName, actionName) {
        console.log(`[Trigger Engine] Checking if trigger action ${actionName} exists for trigger ${triggerName}`);

        const triggerID = this._triggerNamesToIDs[triggerName];

        if (!(triggerID)) {
            throw Error('No such trigger');
        }

        const triggerActions = this._triggerActions[triggerID];

        for (let triggerAction of triggerActions) {
            if (triggerAction.name === actionName) {
                return true;
            }
        }

        return false;
    }

    // Trigger contains all of the fields that we want to update
    updateTrigger(triggerName, trigger) {
        const triggerID = this._triggerNamesToIDs[triggerName];

        return this.repository.updateTrigger(triggerID, trigger)
                   .then(_ => {
                       let existingTrigger = this._triggers[triggerID];

                       for (let fieldName of Object.keys(trigger)) {
                           // Making sure it sets only fields that exist (user
                           // might send additional fields by error)
                           if (fieldName in existingTrigger) {
                               existingTrigger[fieldName] = trigger[fieldName];
                           }
                       }

                       console.log(`[Trigger Engine] Updated trigger ${triggerName}`);
                   })
                   .catch(err => {
                       throw Error(`Could not update trigger ${triggerName}. Error: ${err}`);
                   });
    }

    updateTriggerAction(triggerName, action) {
        const triggerID = this._triggerNamesToIDs[triggerName];

        return this.repository.updateTriggerAction(triggerID, action)
                   .then(_ => {
                       let actions = this._triggerActions[triggerID];

                       for (let existingAction of actions) {
                           if (existingAction.name === action.name) {
                               for (let fieldName of Object.keys(action)) {
                                   // Making sure it sets only fields that
                                   // exist (user might send additional fields
                                   // by error)
                                   if (fieldName in existingAction) {
                                       existingAction[fieldName] = action[fieldName];
                                   }
                               }
                           }
                       }

                       console.log(`[Trigger Engine] Updated trigger action ${action.name}`);
                   })
                   .catch(err => {
                       throw Error(`Could not update trigger action ${action.name}. Error: ${err}`);
                   });
    }

    removeTrigger(triggerName) {
        console.log(`[Trigger Engine] Removing trigger ${triggerName}`);
        const triggerID = this._triggerNamesToIDs[triggerName];

        return this.repository.removeTrigger(triggerName, triggerID)
                   .then(_ => {
                       delete this._triggerNamesToIDs[triggerName];
                       delete this._triggers[triggerID];
                       delete this._triggerActions[triggerID];

                       console.log(`[Trigger Engine] Removed trigger ${triggerName}`);
                   })
                   .catch(err => {
                       throw Error(`Could not remove trigger ${triggerName}. Error: ${err}`);
                   });
    }

    removeTriggerAction(triggerName, action) {
        console.log(`[Trigger Engine] Removing trigger action for trigger ${triggerName}`);
        const triggerID = this._triggerNamesToIDs[triggerName];

        return this.repository.removeTriggerAction(triggerID, action)
                   .then(_ => {
                       let actions                     = this._triggerActions[triggerID];
                       actions                         = actions.filter(a => a.action !== action);
                       this._triggerActions[triggerID] = actions;

                       console.log(`[Trigger Engine] Removed trigger action`);
                   })
                   .catch(err => {
                       throw Error(`Could not remove trigger. Error: ${err}`);
                   });
    }

    invokeTrigger(triggerName) {
        const triggerID = this._triggerNamesToIDs[triggerName];
        let status;

        return this._invokeTrigger(triggerName)
                   .then(_ => {
                       console.log(`[Trigger Engine] Invoked trigger ${triggerName}. Setting last state to 1`);
                       status = 1;
                       this.repository.setLastTriggerStatus(triggerID, status);
                   })
                   .catch(err => {
                       console.log(`[Trigger Engine] Error while invoking trigger ${triggerName}. Error: ${err}`);
                       status = 0;
                       this.repository.setLastTriggerStatus(triggerID, status);
                       throw err;
                   });
    }

    // Called by the API endpoint
    _invokeTrigger(triggerName) {
        const triggerID = this._triggerNamesToIDs[triggerName];
        const trigger   = this._triggers[triggerID];

        if (trigger.data_source_type !== 'url') {
            throw new Error(`Unsupported data source type ${trigger.data_source_type}`);
        }

        return this._invokeURLTrigger(trigger).then(requestResult => {
            const actualValue = requestResult[trigger.variable_1];
            if (actualValue === undefined) {
                throw new Error(`No field ${trigger.variable_1} in the response`);
            }

            const thresholdValue = trigger.variable_2;
            const operator       = trigger.variable_operator;

            let res;
            switch (operator) {
                case '=':
                    if (actualValue === thresholdValue) {
                        res = this._activateTrigger(triggerName);
                    }
                    break;
                case '<':
                    if (actualValue < thresholdValue) {
                        res = this._activateTrigger(triggerName);
                    }
                    break;
                case '<=':
                    if (actualValue <= thresholdValue) {
                        res = this._activateTrigger(triggerName);
                    }
                    break;
                case '>':
                    if (actualValue > thresholdValue) {
                        res = this._activateTrigger(triggerName);
                    }
                    break;
                case '>=':
                    if (actualValue >= thresholdValue) {
                        res = this._activateTrigger(triggerName);
                    }
                    break;
                default:
                    throw new Error(`Invalid operator ${operator}`);
            }

            return res;
        });
    }

    _invokeURLTrigger(trigger) {
        console.log('[Trigger Engine] Invoking trigger with an URL data source');
        let url    = trigger.data_source;
        const vars = trigger.data_source_variable;

        for (let varName of Object.keys(vars)) {
            const varValue = vars[varName];
            url            = url.replace(`[${varName}]`, varValue);
        }

        console.log(`[Trigger Engine] Full URL: ${url}`);

        return axios.get(url)
                    .then(response => {
                        return response.data;
                    })
                    .catch(err => {
                        throw new Error(`Failed to perform HTTP request: ${err.message}`);
                    });
    }

    _activateTrigger(triggerName) {
        const triggerID      = this._triggerNamesToIDs[triggerName];
        const triggerActions = this._triggerActions[triggerID];

        if (triggerActions.length === 0) {
            console.log(`[Trigger Engine] No trigger actions for trigger ${triggerName}`);
            return;
        }

        console.log(`[Trigger Engine] Kicking of ${triggerActions.length} trigger actions for trigger ${triggerName}`);

        const timestamp = Math.floor(ntp.now().getTime() / 1000);

        let promises = [];
        for (let triggerAction of triggerActions) {
            if (triggerAction.status === 0) {
                console.log(`[Trigger Engine] Skipping trigger action because it is disabled`);
                continue;
            }

            let message;

            try {
                this._runTriggerAction(triggerAction);
                message = "OK";
            } catch (err) {
                // Making sure it is less 1000 characters
                message = err.message.substring(0, 1000);
            }

            promises.push(this.repository.setTriggerActionResult(triggerAction.id, message, timestamp));
        }

        let promise = Promise.all(promises);
        return promise;
    }

    _runTriggerAction(triggerAction) {
        const action = triggerAction.action;

        console.log(`[Trigger Action] Executing trigger action ${JSON.stringify(action)}`);

        for (let step of action) {
            if (step.action_type === 'function') {
                try {
                    this._invokeActionFunction(step.module, step.function);
                }
                catch (err) {
                    throw Error(`Error while invoking trigger action: ${err}`);
                }
            }
        }
    }

    _invokeActionFunction(moduleName, functionName) {
        console.log(`[Trigger Engine] Invoking ${moduleName}.${functionName}`);
        const module = this._modules[moduleName];
        module[functionName]();
    }
}


export default new TriggerEngine();