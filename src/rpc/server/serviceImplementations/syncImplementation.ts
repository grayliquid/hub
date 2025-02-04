import grpc from '@grpc/grpc-js';
import { MessagesResponse, GetAllMessagesByFidRequest } from '~/flatbuffers/generated/rpc_generated';
import * as types from '~/flatbuffers/models/types';
import { toMessagesResponse, toServiceError } from '~/rpc/server';
import Engine from '~/storage/engine/flatbuffers';
import { HubError } from '~/utils/hubErrors';

export const syncImplementation = (engine: Engine) => {
  return {
    getAllCastMessagesByFid: async (
      call: grpc.ServerUnaryCall<GetAllMessagesByFidRequest, MessagesResponse>,
      callback: grpc.sendUnaryData<MessagesResponse>
    ) => {
      const result = await engine.getAllCastMessagesByFid(call.request.fidArray() ?? new Uint8Array());
      result.match(
        (messages: (types.CastAddModel | types.CastRemoveModel)[]) => {
          callback(null, toMessagesResponse(messages));
        },
        (err: HubError) => {
          callback(toServiceError(err));
        }
      );
    },

    getAllAmpMessagesByFid: async (
      call: grpc.ServerUnaryCall<GetAllMessagesByFidRequest, MessagesResponse>,
      callback: grpc.sendUnaryData<MessagesResponse>
    ) => {
      const result = await engine.getAllAmpMessagesByFid(call.request.fidArray() ?? new Uint8Array());
      result.match(
        (messages: (types.AmpAddModel | types.AmpRemoveModel)[]) => {
          callback(null, toMessagesResponse(messages));
        },
        (err: HubError) => {
          callback(toServiceError(err));
        }
      );
    },

    getAllReactionMessagesByFid: async (
      call: grpc.ServerUnaryCall<GetAllMessagesByFidRequest, MessagesResponse>,
      callback: grpc.sendUnaryData<MessagesResponse>
    ) => {
      const result = await engine.getAllReactionMessagesByFid(call.request.fidArray() ?? new Uint8Array());
      result.match(
        (messages: (types.ReactionAddModel | types.ReactionRemoveModel)[]) => {
          callback(null, toMessagesResponse(messages));
        },
        (err: HubError) => {
          callback(toServiceError(err));
        }
      );
    },

    getAllVerificationMessagesByFid: async (
      call: grpc.ServerUnaryCall<GetAllMessagesByFidRequest, MessagesResponse>,
      callback: grpc.sendUnaryData<MessagesResponse>
    ) => {
      const result = await engine.getAllVerificationMessagesByFid(call.request.fidArray() ?? new Uint8Array());
      result.match(
        (messages: (types.VerificationAddEthAddressModel | types.VerificationRemoveModel)[]) => {
          callback(null, toMessagesResponse(messages));
        },
        (err: HubError) => {
          callback(toServiceError(err));
        }
      );
    },

    getAllSignerMessagesByFid: async (
      call: grpc.ServerUnaryCall<GetAllMessagesByFidRequest, MessagesResponse>,
      callback: grpc.sendUnaryData<MessagesResponse>
    ) => {
      const result = await engine.getAllSignerMessagesByFid(call.request.fidArray() ?? new Uint8Array());
      result.match(
        (messages: (types.SignerAddModel | types.SignerRemoveModel)[]) => {
          callback(null, toMessagesResponse(messages));
        },
        (err: HubError) => {
          callback(toServiceError(err));
        }
      );
    },

    getAllUserDataMessagesByFid: async (
      call: grpc.ServerUnaryCall<GetAllMessagesByFidRequest, MessagesResponse>,
      callback: grpc.sendUnaryData<MessagesResponse>
    ) => {
      const result = await engine.getUserDataByFid(call.request.fidArray() ?? new Uint8Array());
      result.match(
        (messages: types.UserDataAddModel[]) => {
          callback(null, toMessagesResponse(messages));
        },
        (err: HubError) => {
          callback(toServiceError(err));
        }
      );
    },
  };
};
