import { DECORATORS } from '../constants';
import {
  PARAMTYPES_METADATA,
  ROUTE_ARGS_METADATA
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import {
  mapValues,
  mapKeys,
  pickBy,
  omitBy,
  isEmpty,
  unionWith,
  isNil,
  map,
  flatMap,
  uniqBy,
  negate,
  keyBy,
  groupBy,
  omit,
  assign,
  find,
  isString
} from 'lodash';
import { isFunction, isUndefined } from '@nestjs/common/utils/shared.utils';
import { SwaggerEnumType } from '../types/swagger-enum.type';

export const exploreApiParametersMetadata = (
  definitions,
  instance,
  prototype,
  method
) => {
  const implicitParameters: any[] = Reflect.getMetadata(
    DECORATORS.API_PARAMETERS,
    method
  );
  const reflectedParameters = exploreApiReflectedParametersMetadata(
    instance,
    prototype,
    method
  );
  const noAnyImplicit = isNil(implicitParameters);
  if (noAnyImplicit && isNil(reflectedParameters)) {
    return undefined;
  }

  const allReflectedParameters = transformModelToProperties(
    reflectedParameters || []
  );
  const mergedParameters = noAnyImplicit
    ? allReflectedParameters
    : map(allReflectedParameters, item =>
        assign(item, find(implicitParameters, ['name', item.name]))
      );

  const unionParameters = noAnyImplicit
    ? mergedParameters
    : unionWith(mergedParameters, implicitParameters, (arrVal, othVal) => {
        return arrVal.name === othVal.name && arrVal.in === othVal.in;
      });

  const paramsWithDefinitions = mapModelsToDefinitons(
    unionParameters,
    definitions
  );
  const parameters = mapParametersTypes(paramsWithDefinitions);
  return parameters ? { parameters } : undefined;
};

const DEFAULT_PARAM_TOKEN = '_';
const exploreApiReflectedParametersMetadata = (instance, prototype, method) => {
  const types = Reflect.getMetadata(PARAMTYPES_METADATA, instance, method.name);
  const parametersMetadata =
    Reflect.getMetadata(ROUTE_ARGS_METADATA, instance, method.name) || {};
  const parametersWithType = mapValues(parametersMetadata, param => ({
    type: types[param.index],
    name: param.data,
    required: true
  }));
  const parameters = omitBy(
    mapValues(parametersWithType, (val, key) => ({
      ...val,
      in: mapParamType(key as any)
    })),
    val => val.in === DEFAULT_PARAM_TOKEN || (val.name && val.in === 'body')
  );
  return !isEmpty(parameters) ? parameters : undefined;
};

const exploreModelProperties = prototype => {
  const props =
    Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES_ARRAY, prototype) || [];
  return props
    .filter(isString)
    .filter(prop => prop.charAt(0) === ':' && !isFunction(prototype[prop]))
    .map(prop => prop.slice(1));
};

const isBodyParameter = param => param.in === 'body';

const transformModelToProperties = reflectedParameters => {
  return flatMap(reflectedParameters, (param: any) => {
    if (!param) {
      return null;
    }
    const { prototype } = param.type;
    // tslint:disable-next-line:curly
    if (param.name) return param;

    if (isBodyParameter(param)) {
      const name: string =
        param.type && isFunction(param.type) ? param.type.name : param.type;
      return { ...param, name };
    }
    const modelProperties = exploreModelProperties(prototype);
    return modelProperties.map(key => {
      const reflectedParam =
        Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES, prototype, key) ||
        {};
      return {
        ...param,
        ...reflectedParam,
        name: key
      };
    });
  });
};

const transformToArrayModelProperty = (metadata, key, type) => {
  const model = {
    ...metadata,
    name: key,
    type: 'array',
    items: {
      ...type
    }
  };

  if (metadata.enum !== undefined) {
    delete model.enum;
    model.items = {
      ...model.items,
      enum: metadata.enum
    };
  }

  return model;
};

export const exploreModelDefinition = (type, definitions) => {
  const { prototype } = type;
  const modelProperties = exploreModelProperties(prototype);
  const propertiesWithType = modelProperties.map(key => {
    const metadata =
      Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES, prototype, key) ||
      {};
    const defaultTypes = [String, Boolean, Number, Object, Array];

    if (metadata.enum !== undefined) {
      metadata.enum = getEnumValues(metadata.enum);
    }

    if (
      isFunction(metadata.type) &&
      !defaultTypes.find(defaultType => defaultType === metadata.type)
    ) {
      const nestedModelName = exploreModelDefinition(
        metadata.type,
        definitions
      );
      const $ref = getDefinitionPath(nestedModelName);
      if (metadata.isArray) {
        return transformToArrayModelProperty(metadata, key, { $ref });
      }
      return { name: key, $ref };
    }
    const metatype: string =
      metadata.type && isFunction(metadata.type)
        ? metadata.type.name
        : metadata.type;
    const swaggerType = mapTypesToSwaggerTypes(metatype);
    const itemType = metadata.enum ? getEnumType(metadata.enum) : swaggerType;

    if (metadata.isArray) {
      return transformToArrayModelProperty(metadata, key, { type: itemType });
    } else {
      return {
        ...metadata,
        name: key,
        type: itemType
      };
    }
  });
  const typeDefinition = {
    type: 'object',
    properties: mapValues(keyBy(propertiesWithType, 'name'), property =>
      omit(property, ['name', 'isArray', 'required'])
    )
  };
  const typeDefinitionRequiredFields = propertiesWithType
    .filter(property => property.required != false)
    .map(property => property.name);
  if (typeDefinitionRequiredFields.length > 0) {
    typeDefinition['required'] = typeDefinitionRequiredFields;
  }
  definitions.push({
    [type.name]: typeDefinition
  });
  return type.name;
};

const getEnumValues = (e: SwaggerEnumType): string[] | number[] => {
  let values = [];

  if (Array.isArray(e)) {
    values = e;
  } else if (typeof e === 'object') {
    const uniqueValues = {};

    for (const key in e) {
      const value = e[key];
      // Filter out cases where enum key also becomes its value (A: B, B: A)
      if (
        !uniqueValues.hasOwnProperty(value) &&
        !uniqueValues.hasOwnProperty(key)
      ) {
        values.push(value);
        uniqueValues[value] = value;
      }
    }
  }

  return values;
};

const getEnumType = (values: (string | number)[]): 'string' | 'number' => {
  const hasString = values.filter(isString).length > 0;
  return hasString ? 'string' : 'number';
};

const mapParamType = (key: string): string => {
  const keyPair = key.split(':');
  switch (Number(keyPair[0])) {
    case RouteParamtypes.BODY:
      return 'body';
    case RouteParamtypes.PARAM:
      return 'path';
    case RouteParamtypes.QUERY:
      return 'query';
    case RouteParamtypes.HEADERS:
      return 'header';
    default:
      return DEFAULT_PARAM_TOKEN;
  }
};

const mapParametersTypes = parameters =>
  parameters.map(param => {
    if (isBodyParameter(param)) {
      return param;
    }
    const { type } = param;
    const paramWithStringifiedType = pickBy(
      {
        ...param,
        type:
          type && isFunction(type)
            ? mapTypesToSwaggerTypes(type.name)
            : mapTypesToSwaggerTypes(type)
      },
      negate(isUndefined)
    );
    if ((paramWithStringifiedType as any).isArray) {
      return {
        ...paramWithStringifiedType,
        type: 'array',
        items: {
          type: mapTypesToSwaggerTypes(param.type)
        }
      };
    }
    return paramWithStringifiedType;
  });

export const mapTypesToSwaggerTypes = (type: string) => {
  if (!(type && type.charAt)) {
    return '';
  }
  return type.charAt(0).toLowerCase() + type.slice(1);
};

const getDefinitionPath = modelName => `#/definitions/${modelName}`;

const mapModelsToDefinitons = (parameters, definitions) => {
  return parameters.map(param => {
    if (!isBodyParameter(param)) {
      return param;
    }
    const modelName = exploreModelDefinition(param.type, definitions);
    const name = param.name ? param.name : modelName;
    const schema = {
      $ref: getDefinitionPath(modelName)
    };
    if (param.isArray) {
      return {
        ...param,
        name,
        schema: {
          type: 'array',
          items: schema
        }
      };
    }
    return {
      ...param,
      name,
      schema
    };
  });
};
