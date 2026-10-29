// where uploaded images and mod files live. in production that's an s3-style
// bucket (railway buckets, cloudflare r2, etc). in development it's a folder.

use std::sync::Arc;

use object_store::aws::AmazonS3Builder;
use object_store::local::LocalFileSystem;
use object_store::path::Path;
use object_store::{ObjectStore, PutPayload};

use crate::config::{Config, StorageConfig};

pub fn build(config: &Config) -> anyhow::Result<Arc<dyn ObjectStore>> {
    match &config.storage {
        StorageConfig::Local { dir } => {
            std::fs::create_dir_all(dir)?;
            tracing::info!("storing uploads in the local folder {}", dir.display());
            Ok(Arc::new(LocalFileSystem::new_with_prefix(dir)?))
        }
        StorageConfig::S3 { bucket, endpoint, region, access_key_id, secret_access_key, path_style } => {
            let mut builder = AmazonS3Builder::new()
                .with_bucket_name(bucket)
                .with_region(region)
                .with_access_key_id(access_key_id)
                .with_secret_access_key(secret_access_key);
            if let Some(endpoint) = endpoint {
                builder = builder
                    .with_endpoint(endpoint)
                    .with_virtual_hosted_style_request(!path_style)
                    .with_allow_http(endpoint.starts_with("http://"));
            }
            tracing::info!("storing uploads in the bucket {bucket}");
            Ok(Arc::new(builder.build()?))
        }
    }
}

pub async fn put(store: &dyn ObjectStore, key: &str, data: Vec<u8>) -> Result<(), object_store::Error> {
    store.put(&Path::from(key), PutPayload::from(data)).await.map(|_| ())
}

/// deletes a stored file. a missing file is fine, other problems are only logged,
/// because the database change already happened and that's what matters.
pub async fn delete_quietly(store: &dyn ObjectStore, key: &str) {
    match store.delete(&Path::from(key)).await {
        Ok(()) | Err(object_store::Error::NotFound { .. }) => {}
        Err(err) => tracing::warn!(error = %err, key, "couldn't delete a stored file"),
    }
}
