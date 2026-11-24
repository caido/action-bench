import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { err, ok, Result } from "neverthrow";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

type ListedObject = { key: string; modified: Date };

export type UseR2Client = ReturnType<typeof useR2Client>;

export const useR2Client = (options: {
  bucket: string;
  owner: string;
  repo: string;
  runId: string;
  attempt: string;
  branch: string;
  sha: string;
}) => {
  const { bucket, owner, repo, runId, attempt, branch, sha } = options;
  const accountId = requiredEnv("R2_ACCOUNT_ID");

  const temporaryPrefix = `action-bench/tmp/${owner}/${repo}/${runId}/${attempt}/`;

  const baselinePrefix = `action-bench/${owner}/${repo}/${encodeURIComponent(branch)}/`;

  const baselineKey = `${baselinePrefix}${sha}/merged.json`;

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
    },
  });

  const uploadTemporaryReport = async (benchmark: string, contents: string) => {
    const key = `${temporaryPrefix}${encodeURIComponent(benchmark)}.json`;

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: contents,
        ContentType: "application/json",
        IfNoneMatch: "*",
      }),
    );

    return key;
  };

  const listTemporaryObject = async () => {
    return (await listObjects(temporaryPrefix)).map(({ key }) => key);
  };

  const deleteTemporaryObjects = async (keys: string[]) =>
    await deleteObjects(keys);

  const uploadBaseline = async (contents: string): Promise<void> => {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: baselineKey,
        Body: contents,
        ContentType: "application/json",
      }),
    );
  };

  const pruneBaselines = async (retention: number): Promise<void> => {
    const objects = await listObjects(baselinePrefix);
    objects.sort((a, b) => b.modified.getTime() - a.modified.getTime());

    for (const object of objects.slice(retention)) {
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: object.key }),
      );
    }
  };

  const latestBaseline = async (): Promise<ListedObject | undefined> => {
    const objects = await listObjects(baselinePrefix);
    objects.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    return objects.at(0);
  };

  const listObjects = async (prefix: string): Promise<ListedObject[]> => {
    let continuationToken: string | undefined;
    const objects: ListedObject[] = [];

    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const item of page.Contents ?? []) {
        if (item.Key && item.LastModified) {
          objects.push({ key: item.Key, modified: item.LastModified });
        }
      }
      continuationToken = page.NextContinuationToken;
    } while (continuationToken);

    return objects;
  };

  const readObject = async (key: string): Promise<Result<string, string>> => {
    const result = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!result.Body) return err(`S3 object has no body: ${key}`);
    return ok(await result.Body.transformToString("utf-8"));
  };

  const deleteObjects = async (keys: string[]): Promise<void> => {
    for (const key of keys) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    }
  };

  return {
    uploadTemporaryReport,
    uploadBaseline,
    pruneBaselines,
    latestBaseline,
    listTemporaryObject,
    deleteTemporaryObjects,
    readObject,
    temporaryPrefix,
    baselineKey,
  };
};
