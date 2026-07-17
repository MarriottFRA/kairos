import api from './api';

export interface SubmittedDataEntry {
  ou: string;
  period: string;
  department: string;
  account: string;
  amount: number;
  scenario: string;
  version: string;
  currency: string;
  load_id: string;
  source_acc?: string | null;
  source_dep?: string | null;
  source_desc?: string | null;
}

export interface SubmittedDataResponse extends SubmittedDataEntry {
  id: number;
  load_date: string;
}

export interface BulkUploadRequest {
  data: SubmittedDataEntry[];
  signed_by: string;
}

class SubmittedDataService {
  /**
   * Upload data in bulk to the submitted-data endpoint
   * @param data Array of submitted data entries
   * @param signedBy Email of the person signing off on the data
   * @returns Promise with the uploaded data including IDs and load dates
   */
  async uploadBulk(data: SubmittedDataEntry[], signedBy: string): Promise<SubmittedDataResponse[]> {
    const response = await api.post(`/submitted-data/bulk`, {
      data,
      signed_by: signedBy
    } as BulkUploadRequest);

    if (!response.ok) {
      const error = await response.json();

      // Handle 422 validation errors with detail array
      if (Array.isArray(error.detail)) {
        const errorMessages = error.detail.map((err: any) =>
          `${err.loc?.join(' -> ') || 'Field'}: ${err.msg}`
        ).join('\n');
        throw new Error(`Validation errors:\n${errorMessages}`);
      }

      throw new Error(error.detail || 'Failed to upload data');
    }

    return await response.json();
  }
}

export default new SubmittedDataService();
