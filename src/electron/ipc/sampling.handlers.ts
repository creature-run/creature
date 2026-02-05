import { ipcMain } from "electron";
import { handleSamplingResponse, type SamplingResponse } from "../mcp/sampling";

export const registerSamplingHandlers = () => {
  ipcMain.handle("sampling:respond", async (_event, response: SamplingResponse) => {
    return handleSamplingResponse(response);
  });
};
