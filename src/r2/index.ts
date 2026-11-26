import {
  BucketAlreadyOwnedByYou,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  waitUntilBucketExists,
} from "@aws-sdk/client-s3";
import { err, ok, Result } from "neverthrow";
import { safeRequireEnv, toErrorMessage } from "../utils";

type ListedObject = { key: string; modified: Date };

export type UseR2Client = ReturnType<typeof createR2Methods>;

type R2Options = {
  bucket: string;
  owner: string;
  repo: string;
  runId: string;
  attempt: string;
  branch: string;
  sha: string;
};

const createClient = () => {
  const accountId = safeRequireEnv("R2_ACCOUNT_ID");
  const accessKeyId = safeRequireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = safeRequireEnv("R2_SECRET_ACCESS_KEY");

  if (accountId.isErr()) return err(accountId.error);
  if (accessKeyId.isErr()) return err(accessKeyId.error);
  if (secretAccessKey.isErr()) return err(secretAccessKey.error);

  return ok(
    new S3Client({
      region: "auto",
      endpoint: `https://${accountId.value}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: accessKeyId.value,
        secretAccessKey: secretAccessKey.value,
      },
    }),
  );
};

const ensureBucketExists = async (
  client: S3Client,
  bucket: string,
): Promise<Result<string, string>> => {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return ok(bucket);
  } catch (error) {
    if (!(error instanceof S3ServiceException)) return err(toErrorMessage(error));

    const status = error.$metadata.httpStatusCode;
    if (status === 403) {
      return err(
        `Access denied to "${bucket}": it may belong to another account, or you lack permission.`,
      );
    }
    if (status !== 404) return err(toErrorMessage(error));
  }

  try {
    await client.send(
      new CreateBucketCommand({
        Bucket: bucket,
      }),
    );
  } catch (error) {
    if (!(error instanceof BucketAlreadyOwnedByYou)) return err(toErrorMessage(error));
  }

  await waitUntilBucketExists({ client, maxWaitTime: 60 }, { Bucket: bucket });

  return ok(bucket);
};

export const useR2Client = async (options: R2Options): Promise<Result<UseR2Client, string>> => {
  const clientResult = createClient();

  if (clientResult.isErr()) return err(clientResult.error);

  const client = clientResult.value;

  const doesExists = await ensureBucketExists(client, options.bucket);
  if (doesExists.isErr()) return err(doesExists.error);

  return ok(createR2Methods(client, options));
};

const createR2Methods = (client: S3Client, options: R2Options) => {
  const { bucket, owner, repo, runId, attempt, branch, sha } = options;

  const temporaryPrefix = `action-bench/tmp/${owner}/${repo}/${runId}/${attempt}/`;

  const baselinePrefix = `action-bench/${owner}/${repo}/${encodeURIComponent(branch)}/`;

  const baselineKey = `${baselinePrefix}${sha}/merged.json`;

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

  const deleteTemporaryObjects = async (keys: string[]) => await deleteObjects(keys);

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
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.key }));
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
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
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
