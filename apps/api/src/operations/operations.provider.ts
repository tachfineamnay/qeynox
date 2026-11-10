import { connectDatabase, QeyNoxStore } from '@qeynox/persistence';
import { OperationService, OperationExecutionService, PlanningService, ResultService } from '@qeynox/application';

export const QEYNOX_STORE=Symbol('QEYNOX_STORE');
export const OPERATIONS_SERVICE=Symbol('OPERATIONS_SERVICE');
export const EXECUTION_SERVICE=Symbol('EXECUTION_SERVICE');
export const PLANNING_SERVICE=Symbol('PLANNING_SERVICE');
export const RESULTS_SERVICE=Symbol('RESULTS_SERVICE');
export const provideStore={provide:QEYNOX_STORE,useFactory:()=>new QeyNoxStore(connectDatabase(process.env.DATABASE_URL).db)};
export const provideOperations={provide:OPERATIONS_SERVICE,useFactory:(store:QeyNoxStore)=>new OperationService(store),inject:[QEYNOX_STORE]};
export const provideExecution={provide:EXECUTION_SERVICE,useFactory:(store:QeyNoxStore)=>new OperationExecutionService(store),inject:[QEYNOX_STORE]};
export const providePlanning={provide:PLANNING_SERVICE,useFactory:(store:QeyNoxStore)=>new PlanningService(store),inject:[QEYNOX_STORE]};
export const provideResults={provide:RESULTS_SERVICE,useFactory:(store:QeyNoxStore)=>new ResultService(store),inject:[QEYNOX_STORE]};
