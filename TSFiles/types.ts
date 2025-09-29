import { IntegratedDynamicsClasses } from "./IntegratedDynamicsClasses";
import { operatorRegistry } from "./operatorRegistry";

export type TypeFunction = { kind: "Function"; from: TypeAny | TypeConcrete | TypeGeneric | TypeFunction | TypeList; to: TypeAny | TypeConcrete | TypeGeneric | TypeFunction | TypeList };
export type TypeAny = { kind: "Any"; typeID: string; argName?: string };
export type TypeConcrete = { name: "Integer" | "Long" | "Double" | "Boolean" | "String" | "Number"; kind: "Concrete" };
export type TypeGeneric = { name: string; kind: "Generic"; of: TypeConcrete | TypeAny | TypeList; argName?: string };
export type TypeOperator = { kind: "Operator"; args: TypeFunction[] };
export type TypeList = { kind: "Concrete"; name: "List"; params: TypeAny[] | TypeConcrete[] | TypeGeneric[] | TypeFunction[] | TypeList[] };
export type TypeTypeMap = { [typeID: string]: string };
export type TypeLambda<P, R> = (...args: [P]) => R;
export type TypeInteger = InstanceType<typeof IntegratedDynamicsClasses.Number> & { dataType: "Integer" };
export type TypeLong = InstanceType<typeof IntegratedDynamicsClasses.Number> & { dataType: "Long" };
export type TypeDouble = InstanceType<typeof IntegratedDynamicsClasses.Number> & { dataType: "Double" };
export type TypeNumber = TypeInteger | TypeLong | TypeDouble;
export type TypeNumericString = `${number}` | `-${number}`;
export type TypeOperatorKey = keyof typeof operatorRegistry["baseOperators"];
export type TypeOperatorNicknames = typeof operatorRegistry["baseOperators"][TypeOperatorKey]["nicknames"][number];
export type TypeOperatorInternalName = typeof operatorRegistry["baseOperators"][TypeOperatorKey]["internalName"];

export interface TypeOperatorRegistry {
  baseOperators: {
    [k: string]: InstanceType<typeof IntegratedDynamicsClasses.Operator>;
  };
  typeSerializers: {
    [k: string]: { valueType: string; nbtType: string };
  };
}

export namespace SNBTTypes {
  export type int = number & { __int: void };

  export interface OperatorWrapper<T = Operator> {
    v: T;
  }

  export interface CombinedPipe {
    serializer: "integrateddynamics:combined.pipe";
    value: {
      operators: OperatorWrapper<Operator>[];
    };
  }

  export interface CombinedFlip {
    serializer: "integrateddynamics:combined.flip";
    value: {
      operators: OperatorWrapper<Operator>[];
    };
  }

  export interface Curry {
    serializer: "integrateddynamics:curry";
    value: {
      baseOperator: OperatorWrapper<Operator>;
      values: {
        value: Operator;
        valueType: string;
      }[];
    };
  }

  export type Operator =
    | CombinedPipe
    | CombinedFlip
    | Curry
    | TypeOperatorInternalName;

  export interface RootSNBT {
    _id: int;
    _type: "integrateddynamics:valuetype";
    typeName: string;
    value: Operator;
  }
}